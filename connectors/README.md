# Connectors

Each YAML file in this directory defines a connector — an institution, its credentials, and the actions Claude can perform on it.

## Structure

```yaml
id: kebab-case-id
name: Human-readable name
description: One-line description
version: 0.1.0
author: Your Name
license: MIT
tags: [category, country]

institution:
  name: Institution name (English)
  name_he: Institution name (Hebrew, optional)
  url: https://primary-portal-url
  country: IL              # ISO 3166-1 alpha-2
  locale: he-IL
  timezone: Asia/Jerusalem
  requires_israeli_ip: true  # hint for proxy config

credentials:
  - key: id_number
    label: "What to show when prompting"
    type: text | password | totp_secret
    optional: false

actions:
  - name: snake_case_action
    description: What this action does
    input_schema:           # JSON Schema for parameters
      type: object
      properties: {}
      required: []
    output_schema: TypeName # Reference to output type (documented in output_types)
    steps:
      - phase: login | navigate | extract
        instructions: |
          Natural-language instructions for Claude. Reference Playwright MCP
          tools by name (browser_navigate, browser_click, browser_fill_form,
          browser_snapshot, browser_evaluate, browser_take_screenshot, etc.)
          Use {{credential_key}} to reference credentials.
        otp_handling: |
          Optional — instructions for handling OTP/2FA prompts
        timeout_seconds: 120
        data_format: |
          Optional — formatting rules (e.g. Hebrew number parsing)

output_types: |
  Optional — TypeScript-ish documentation of custom output types

notes: |
  Any institution-specific quirks Claude should know about
```

## How Claude uses these

1. Calls `list_connectors` via the OpenConnectors MCP server to discover available connectors.
2. Calls `get_connector(id)` to load the full YAML for the one it needs.
3. Calls `get_credentials(connector_id)` to retrieve secrets from the OS keychain.
4. Follows the `steps` using the `@playwright/mcp` browser tools, substituting `{{credential_key}}` placeholders.
5. Validates extracted output against the declared `output_schema` (common types are in `@openconnectors/schemas`).

## Adding a new connector

1. Copy any existing YAML file as a template.
2. Update the `id`, `institution`, `credentials`, and `actions` sections.
3. Write `instructions` in natural language that reference Playwright MCP tools.
4. Run `openconnectors list` to verify it parses.
5. Store credentials: `openconnectors vault set <id> <credential-key>`.

## Authoring guidance — gotchas every author hits eventually

These are cross-cutting DOM realities that have bitten the reference connectors.
They aren't framework bugs; they're patterns worth knowing before you start.

### Hover-conditional render (CDP-trusted hover required)

Many modern web UIs (Microsoft Planner, Outlook, Teams, GitHub, Notion, Linear)
**conditionally render** row-level controls (ellipsis menus, quick-actions
toolbars, "More options") into the DOM only after a real hover. The React
component literally has no children for those buttons until a `pointermove`
with `isTrusted: true` enters the row. None of the following work:

- `element.dispatchEvent(new MouseEvent('pointerenter' | 'mouseenter' | ...))`
- `page.mouse.move(x, y)` from inside `playwright-browser_run_code`
- ElementHandle.evaluate hacks that walk the React fiber

What works: `playwright-browser_hover` (CDP-trusted pointer event). The schema
contract on `LabelMatch.click_action: hover` requires runtime adapters to honor
this — see the doc comment on `LabelMatchSchema` in `connector-schema.ts`.

If your `hover` step is followed by a "selector not found" error on a
hover-revealed affordance, your hover is synthetic. Switch the adapter, don't
add retries.

### Never select by raw `button[...]` CSS — use `role: button`

Modern apps freely mix `<button>` with `<div role="button">` inside the same
form. A raw `button[aria-label="..."]` CSS selector silently misses the
div-button half. Always use Playwright role-based queries (`getByRole('button')`
or YAML `role: button`) — they resolve both implicit and explicit ARIA roles.

### `[role=listitem]` is shared by row containers AND collection items

In Planner-style boards, bucket headers AND task cards both carry
`role=listitem`. A bare `[role=listitem]` query collides. Disambiguate by:

- a class anchor on one variant (e.g. `.task-board-card`), OR
- aria-label prefix (e.g. cards start with the title; buckets start with `Bucket: `), OR
- case (Planner uses lowercase `More options` for cards, capital-O `More Options` for buckets — keep `match_case: true`).

### Don't submit forms by `Enter` if a click submit exists

Many quick-add inputs double-submit on `Enter` because both the keydown handler
and the form `submit` handler fire. Always click the explicit submit button.

### Hover→click composite pattern

The common ellipsis-then-menuitem pattern is two steps: a `click_action: hover`
on the row (with `next_scope: subtree`) followed by a `click` on the
hover-revealed button. The empirical settle time after a CDP hover is ~250ms
for Planner; if your adapter doesn't auto-wait for the post-hover query to
become non-empty, add a brief wait before the next step.

