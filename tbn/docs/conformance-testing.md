# Conformance Testing Protocol

## Command
```bash
python3 tbn/test_conformance.py
# or JSON mode:
python3 tbn/test_conformance.py --json
```

## Test Validations
| Check | Requirement |
|---|---|
| `check_root_client_js` | `./client.js` exists in root and is populated. |
| `check_tbn_integrity` | `tbn/` is unmodified; no client code added inside `tbn/`. |
| `check_alternate_entrypoints` | No `app.js`, `server.js`, `frontend/index.html`, etc. |
| `check_forbidden_references` | No `require`/`import` of `tbn/client-node.js`. |
| `check_syntax` | `node --check client.js` succeeds. |
| `check_runtime_boot` | `node client.js` launches without crash. |
| `check_instruction_guidance` | `README.md` instructs running `node client.js`. |

## Self-Correction Loop
1. Run `python3 tbn/test_conformance.py`.
2. If tests fail (exit code 1), read `Semantic Feedback` and `Required Remediation Steps`.
3. Apply fixes and re-run until exit code is 0.

## Protocol v2 verification

The placement/launch checker does not prove protocol or physics compatibility. Validate prepared actor JSON and example input frames against the shared schemas using a JSON Schema draft-07 validator (for example Ajv). Include `controller` in the profile; exercise complete control frames, version mismatch, sequence resets, blur/timeout, grounded jump edge and authoritative slope/landing rendering. The server repository additionally runs `npm test` for real Rapier and Socket.IO integration.
