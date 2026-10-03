/** Scenario id exactly as `parseSpec` builds it: slug("<Requirement title> <Scenario title>"). */
export function sc(requirement: string, scenario: string): string {
  return `${requirement} ${scenario}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
