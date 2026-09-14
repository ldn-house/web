# Development requirements

## Visual changes

Every pull request that changes the UI must include before and after screenshots of the affected views. Capture the original appearance before making changes, then capture the result under comparable conditions (viewport, application state, and data) so reviewers can assess the difference. Use public or synthetic data in screenshots; do not expose private personal data.

## Verification and validation

Validate changes by running the application or affected code path and inspecting its actual behavior. Exercise the changed flow and relevant adjacent flows, confirm the result works as expected, check for runtime errors (including browser console and server errors where applicable), and check for unintended effects.

In each pull request, report the specific scenarios exercised, the observed outcomes, and any limitations or behavior that could not be verified. Validation must describe concrete evidence, not generic statements such as "ran the test suite." Do not include type checking or linting in the reported validation; these checks, and automated tests alone, do not replace runtime validation. Continue to run required automated checks separately.

## Octopus API changes

Document changes to Octopus API usage, including added or modified request patterns, in the pull request and maintain relevant repository documentation where the behavior is described. Explain:

- Which endpoints are called and what triggers the requests, including polling, retries, pagination, caching, and deduplication where relevant.
- How request frequency and volume change compared with the previous behavior, including how they scale with users, accounts, or other relevant factors.
- The effect on rate-limit consumption and how throttling or rate-limit responses are handled. State assumptions and uncertainties rather than inventing limits or estimates.
- The trade-offs between request volume and data freshness/liveness, including refresh intervals, cache lifetimes, and when users may see stale data.

Validate the changed request behavior at runtime and report what was observed, including request counts or timing where relevant, so reviewers can assess the rate-limit and freshness trade-offs.
