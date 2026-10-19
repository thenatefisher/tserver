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
