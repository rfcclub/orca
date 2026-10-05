import { getChangeDir, getProjectRoot } from '../utils.js';
import { signLocalOutcomeReview } from '../../harness/local-review.js';

export async function cmdReviewOutcome(name: string, args: string[]): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Invalid change name');
  const flag = (key: string) => {
    const i = args.indexOf(key);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const stage = flag('--stage'), digest = flag('--digest');
  const reviewer = flag('--reviewer'), keyPath = flag('--key');
  if (!stage || !digest || !reviewer || !keyPath) {
    throw new Error('Usage: orca review-outcome <name> --stage <id> --digest <sha256> --reviewer <id> --key <absolute private-key path>');
  }
  await signLocalOutcomeReview(getChangeDir(name), getProjectRoot(), { stage, digest, reviewer, keyPath });
  console.log(`Signed local review for ${stage} at ${digest}; run orca check-outcomes ${name} --local-review`);
}
