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
