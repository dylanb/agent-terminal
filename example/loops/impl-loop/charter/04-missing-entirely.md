### Missing-entirely findings

Omit `line` (keep `file`) when the finding is "this thing is missing" (e.g., no rate limiting on new HTTP handlers in `internal/api/`). Shotgun findings without a concrete file pointer are rejected.

