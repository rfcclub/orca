import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashBytes } from '../../src/verify/execution.js';
const mutationPath = '../../dist/property/mutation.js';
const { probeMutation, equivalenceDigest } = await import(mutationPath);
import { readTestContract } from '../../src/verify/change.js';

const bridgePath = '../../dist/harness/property-seal.js';
const helper = fileURLToPath(new URL('../../dist/property/runtime.js', import.meta.url));
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'orca-seal-property-'));
  const dir=join(root,'openspec/changes/demo');
  mkdirSync(join(dir,'specs/demo'),{recursive:true}); mkdirSync(join(root,'tests'));
  writeFileSync(join(root,'package.json'),'{"type":"module"}');
  writeFileSync(join(root,'.gitignore'),'node_modules\n');
  writeFileSync(join(root,'source.js'),'export const value=2;\n');
  writeFileSync(join(dir,'specs/demo/spec.md'),`## ADDED Requirements
### Requirement: Value
The result MUST equal two.
#### Property: correct
- **FOR ALL** n: integer
- **THEN** value equals two
- **RUNS** 10
`);
  writeFileSync(join(dir,'.traceability.yaml'),JSON.stringify({scenarios:[{scenario:'value-correct',test:'tests/value.test.js',generators:['tests/value.test.js'],corpus:'orca/corpus/value-correct.json'}]}));
  writeFileSync(join(root,'tests/value.test.js'),`import {it,expect} from 'vitest';
import {value} from '../source.js';
import {assertProperty,fc} from ${JSON.stringify(helper)};
it('[value-correct]',async()=>{const r=await assertProperty({id:'value-correct',seed:31,numRuns:10,corpus:'orca/corpus/value-correct.json',arbitrary:fc.integer(),predicate:()=>value===2});expect(r.failed).toBe(false);});`);
  symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');
  execFileSync('git',['init','-q'],{cwd:root}); execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=fixture','-c','user.email=f@example.invalid','commit','-qm','base'],{cwd:root});
  const selection=readTestContract(root,dir,'demo').selection;
  const save=(after:string,id='mutant')=>{
    const receipt=probeMutation(root,selection,{version:1,id,rationale:'Change required value',changes:[{path:'source.js',before_sha256:hashBytes(readFileSync(join(root,'source.js'))),after}]});
    mkdirSync(join(dir,'.harness/property-probes'),{recursive:true});
    const path=join(dir,'.harness/property-probes',`${id}.json`);writeFileSync(path,JSON.stringify(receipt));return {receipt,path};
  };
  return {root,dir,selection,save,clean:()=>rmSync(root,{recursive:true,force:true})};
}
async function bridge(f:ReturnType<typeof fixture>,reviewersFile?:string) {
  const api=await import(bridgePath).catch(()=>null);
  expect(api?.createPropertySealBridge).toBeTypeOf('function');
  return api!.createPropertySealBridge(f.root,f.dir,'demo',{reviewersFile});
}
it('[current-executable-evidence-actual-kill] actual kill uses current source and preserves caller',async()=>{
  const f=fixture();try{
    const b=await bridge(f);const probe=f.save('export const value=3;\n');expect(probe.receipt.status,JSON.stringify(probe.receipt)).toBe('killed');
    const reviews=await b.verify({},b.contracts);
    expect(reviews[0]).toMatchObject({status:'verified',fresh:true,runs_actual:10,seed:31,mutants:[{id:'mutant',outcome:'killed'}]});
    expect(readFileSync(join(f.root,'source.js'),'utf8')).toBe('export const value=2;\n');
  }finally{f.clean();}
},60000);
it.each([['survived','export const value=2+0;\n'],['invalid','export const value=!!!;\n']])('[current-executable-evidence-adverse-mutation] ignores forged killed flag for %s',async(outcome,after)=>{
  const f=fixture();try{const b=await bridge(f);const saved=f.save(after);saved.receipt.status='killed';writeFileSync(saved.path,JSON.stringify(saved.receipt));
    expect((await b.verify({},b.contracts))[0].mutants[0].outcome).toBe(outcome);
  }finally{f.clean();}
},60000);
it('missing probes are unavailable and changed generator bindings invalidate cached contract',async()=>{
  const f=fixture();try{const b=await bridge(f);expect((await b.verify({},b.contracts))[0].mutants[0].outcome).toBe('unavailable');
    writeFileSync(join(f.root,'tests/value.test.js'),readFileSync(join(f.root,'tests/value.test.js'),'utf8')+'\n// changed generator\n');
    await expect(b.verify({},b.contracts)).rejects.toThrow(/contract|changed|stale/i);
  }finally{f.clean();}
},60000);
it('cached probe becomes invalid after caller source changes',async()=>{
  const f=fixture();try{const b=await bridge(f);const probe=f.save('export const value=3;\n');expect(probe.receipt.status,JSON.stringify(probe.receipt)).toBe('killed');writeFileSync(join(f.root,'source.js'),'export const value=2+0;\n');
    expect((await b.verify({},b.contracts))[0].mutants[0].outcome).toBe('invalid');
  }finally{f.clean();}
},60000);
it('[independent-equivalence-reviewed-survivor] checks a real independent signature and rejects forgery',async()=>{
  const f=fixture();const keys=mkdtempSync(join(tmpdir(),'orca-seal-keys-'));try{
    const config=join(keys,'reviewers.json');const pair=generateKeyPairSync('ed25519');
    writeFileSync(config,JSON.stringify({version:1,reviewers:[{id:'owner',kind:'human',publicKey:pair.publicKey.export({type:'spki',format:'pem'})}]}));
    const b=await bridge(f,config);const s=f.save('export const value=2+0;\n');const rationale='Arithmetic identity';const digest=equivalenceDigest(s.receipt,rationale);
    s.receipt.status='equivalent';s.receipt.equivalence={reviewer:'owner',rationale,digest,signature:sign(null,Buffer.from(JSON.stringify(['orca-property-equivalence/v1',digest])),pair.privateKey).toString('base64')};
    writeFileSync(s.path,JSON.stringify(s.receipt));
    expect((await b.verify({},b.contracts))[0].mutants[0]).toMatchObject({outcome:'equivalent',equivalence_verified:true});
    s.receipt.equivalence.rationale='Different meaning';writeFileSync(s.path,JSON.stringify(s.receipt));
    expect((await b.verify({},b.contracts))[0].mutants[0].outcome).toBe('invalid');
  }finally{f.clean();rmSync(keys,{recursive:true,force:true});}
},60000);
it('[gate-compatibility-unsupported-seal] mandatory Property gates refuse an older Seal API',async()=>{
  const f=fixture();try{
    writeFileSync(join(f.dir,'self-check.md'),'# Self Check\n\n## Claims\n- Property passes\n\n## Evidence\n```sh\nnpm test\n```\n');
    vi.resetModules();
    vi.doMock('seal-gate',()=>({Seal:{review:async()=>({verdict:'PASS'})}}));
    const { runGateCode }=await import('../../src/harness/gate-code.js');
    await expect(runGateCode({changeDir:f.dir,projectRoot:f.root,skipStateCheck:true,
      sealReviewFn:async()=>({verdict:'PASS',trust_score:100,blocking_issues:[],next_action:'done'})})).rejects.toThrow(/Seal.*Property|Property.*Seal/i);
  }finally{vi.doUnmock('seal-gate');vi.resetModules();f.clean();}
},60000);
it('real Seal gate blocks a surviving mandatory Property despite an optimistic review hook',async()=>{
  const f=fixture();try{
    f.save('export const value=2+0;\n');
    writeFileSync(join(f.dir,'self-check.md'),'# Self Check\n\n## Claims\n- value equals two\n\n## Evidence\n- command: npm test\n  exit_code: 0\n  output: value equals two\n');
    const gatePath='../../dist/harness/gate-code.js';
    const {runGateCode}=await import(gatePath);
    let overrideCalled=false;
    const result=await runGateCode({changeDir:f.dir,projectRoot:f.root,skipStateCheck:true,
      sealReviewFn:async()=>{overrideCalled=true;return {verdict:'PASS',trust_score:100,blocking_issues:[],next_action:'done'};}});
    expect(overrideCalled).toBe(false);
    expect(result.verdict).toBe('BLOCK');
    expect(result.blocking_issues.some((i:{rule_id?:string})=>i.rule_id==='PMUST-03')).toBe(true);
  }finally{f.clean();}
},60000);
it('ordinary custom gate without a spec preserves its existing review hook',async()=>{
  const f=fixture();try{
    rmSync(join(f.dir,'specs/demo/spec.md'));
    writeFileSync(join(f.dir,'self-check.md'),'# Self-Check\n\n## Claims\n- ordinary review\n\n## Evidence\n```json\n[]\n```\n');
    const gatePath='../../dist/harness/gate-code.js';const {runGateCode}=await import(gatePath);
    let called=false;
    const result=await runGateCode({changeDir:f.dir,projectRoot:f.root,skipStateCheck:true,
      sealReviewFn:async()=>{called=true;return {verdict:'PASS',trust_score:100,blocking_issues:[],next_action:'done'};}});
    expect(called).toBe(true);expect(result.verdict).toBe('PASS');
  }finally{f.clean();}
});
