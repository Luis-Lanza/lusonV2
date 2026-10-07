// Suppress Playwright call logs/DOM snapshots: login assertions can contain TEST
// credentials or authenticated identity. Titles and status are nonsecret.
export default class SafeReporter {
  onTestEnd(test, result) { console.log(`Browser check: ${test.title}: ${result.status}`); }
  onEnd(result) { console.log(`Browser suite: ${result.status}`); }
  printsToStdio() { return true; }
}
