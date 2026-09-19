# Ideas availability

## Findings

IdeasPanel previously filtered only product/model visibility. It did not use
installed skill status, disabled/policy states, missing dependencies or service
configuration. All visible cards used the same composer handoff.

The household task skill explicitly needs notion_action and a target database;
the booking workflow needs a calendar service. Their presence as bundled prompt
templates was not evidence that those services were configured. The smart-home
card was framed as a plan but selected an execution-oriented skill.

## Changes

- Default to cards meeting reported skill and integration prerequisites.
- Separate needs-setup and planning-only tabs. Missing skills, disabled skills,
  policy restrictions, platform/dependency failures and unconfigured services
  get explicit reasons and a settings action, not a composer launch.
- Refresh on entry, focus, skill inventory changes and manual refresh. Recheck
  before composer handoff; stale readiness cannot bypass a new configuration
  failure. Failed checks do not fall back to treating everything as available.
- Smart-home plan becomes a text-only prompt, without the device execution skill.
- Declare missing prerequisites for Peekaboo (macOS and CLI), Blogwatcher (CLI)
  and local-websearch (SEARXNG_URL).

## Validation

- Five focused suites: 145 tests passed (53 UI/catalog checks, 92 loader and
  eligibility checks).
- Actual IdeasPanel browser harness: missing Notion/calendar, configured Notion,
  disconnect before click, disabled skill, settings routing, plan-only handoff,
  failed status lookup and retry all passed.
- Desktop and narrow viewport screenshots inspected; no horizontal overflow in
  the tested narrow layout.
- Renderer production build and diff whitespace check passed.
- Full-project TypeScript check remains unsuccessful (313 diagnostic lines).
  The IdeasPanel diagnostic is the existing ImportMeta.env declaration issue;
  no diagnostic was reported in the new availability module or its tests.

## Limits

Available means known prerequisites are satisfied, not guaranteed task success.
Built-in service configuration is not a live credential/API health probe. Site
login, permission prompts, target database IDs, input files and task details can
still be needed. Tests mocked desktop status APIs; no real booking, Notion write,
device control or external account verification was performed. No installer
was built or existing user configuration changed.
