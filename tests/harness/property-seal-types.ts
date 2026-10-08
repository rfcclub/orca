/** Public callback interoperability check; run with tsc --noEmit --module NodeNext. */
import { Seal } from 'seal-gate';
import { createPropertySealBridge } from '../../dist/harness/property-seal.js';
declare const bridge: ReturnType<typeof createPropertySealBridge>;
const options: Parameters<typeof Seal.review>[1] = { propertyEvidenceVerifier: bridge.verify };
void options;
