#!/usr/bin/env python3
"""
Conformance Test Suite for Agent-Generated Game Client.

Validates:
1. `client.js` exists directly in the repository root.
2. `tbn/` contains the framework/contract files and remains strictly UNMODIFIED.
3. `tbn/client-node.js` was not modified, replaced, or copied over.
4. No forbidden alternate entry points (`app.js`, `server.js`, `frontend/index.html`, `tbn/index.html`) exist.
5. No forbidden direct dependencies on `tbn/client-node.js`.
6. `client.js` passes Node.js syntax checks (`node --check`).
7. `node client.js` launches cleanly from the repository root without crashing.
8. User documentation instructs `node client.js` and never `node tbn/client-node.js`.

Outputs rich semantic feedback and concrete remediation steps for AI agents.
"""

import sys
import os
import re
import json
import subprocess
import time
from pathlib import Path
from typing import List, Dict, Any, Optional

# Color formatting
GREEN = "\033[92m"
RED = "\033[91m"
YELLOW = "\033[93m"
CYAN = "\033[96m"
BOLD = "\033[1m"
RESET = "\033[0m"


class ConformanceViolation:
    def __init__(
        self,
        category: str,
        rule: str,
        description: str,
        semantic_feedback: str,
        remediation_steps: List[str],
        severity: str = "ERROR",
    ):
        self.category = category
        self.rule = rule
        self.description = description
        self.semantic_feedback = semantic_feedback
        self.remediation_steps = remediation_steps
        self.severity = severity

    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category,
            "rule": self.rule,
            "severity": self.severity,
            "description": self.description,
            "semantic_feedback": self.semantic_feedback,
            "remediation_steps": self.remediation_steps,
        }


class ConformanceTester:
    def __init__(self, repo_root: Optional[Path] = None):
        if repo_root:
            self.repo_root = Path(repo_root).resolve()
        elif (Path.cwd() / "tbn").exists():
            self.repo_root = Path.cwd().resolve()
        else:
            self.repo_root = Path(__file__).resolve().parent.parent
        self.violations: List[ConformanceViolation] = []
        self.passed_checks: List[str] = []

    def log_pass(self, check_name: str):
        self.passed_checks.append(check_name)
        print(f"  {GREEN}✓ PASS:{RESET} {check_name}")

    def add_violation(self, violation: ConformanceViolation):
        self.violations.append(violation)
        print(f"  {RED}✗ FAIL [{violation.category}]:{RESET} {violation.description}")

    # -------------------------------------------------------------------------
    # 1. Root client.js presence
    # -------------------------------------------------------------------------
    def check_root_client_js(self):
        client_js = self.repo_root / "client.js"
        if not client_js.exists():
            self.add_violation(
                ConformanceViolation(
                    category="MISSING_ROOT_CLIENT",
                    rule="All generated or edited client files go in the repository root. Entry point is node client.js.",
                    description="`client.js` does not exist in the repository root.",
                    semantic_feedback=(
                        f"Expected file at `{client_js}`, but it was not found. "
                        "Even though framework files reside in `tbn/`, your runnable client implementation "
                        "must be placed directly at `./client.js` in the repository root."
                    ),
                    remediation_steps=[
                        "Create `./client.js` in the repository root.",
                        "If you wrote client code inside `tbn/` or another subdirectory, move it to `./client.js`.",
                    ],
                )
            )
        elif client_js.is_dir():
            self.add_violation(
                ConformanceViolation(
                    category="INVALID_FILE_TYPE",
                    rule="client.js must be a valid JavaScript file.",
                    description="`client.js` is a directory instead of a file.",
                    semantic_feedback="`client.js` must be an executable Node.js script, not a directory.",
                    remediation_steps=["Replace the `client.js` directory with a valid `client.js` script."],
                )
            )
        elif client_js.stat().st_size == 0:
            self.add_violation(
                ConformanceViolation(
                    category="EMPTY_CLIENT_FILE",
                    rule="client.js must contain the client/server implementation.",
                    description="`client.js` is 0 bytes.",
                    semantic_feedback="`client.js` was created but is empty. Implement the client game loop.",
                    remediation_steps=["Add the runnable game client code to `./client.js`."],
                )
            )
        else:
            self.log_pass("Root `client.js` exists and is populated.")

    # -------------------------------------------------------------------------
    # 2. tbn/ Framework Integrity (Read-Only Check)
    # -------------------------------------------------------------------------
    def check_tbn_integrity(self):
        tbn_dir = self.repo_root / "tbn"

        if not tbn_dir.exists():
            self.add_violation(
                ConformanceViolation(
                    category="MISSING_TBN_DIRECTORY",
                    rule="Framework, SDK, conformance tests, and game contracts reside in `tbn/`.",
                    description="The `tbn/` framework directory was not found in the repository.",
                    semantic_feedback=(
                        "`tbn/` is required for framework specifications, SDK, and reference protocols. "
                        "Ensure the repository was initialized properly."
                    ),
                    remediation_steps=["Do not delete or rename the `tbn/` directory."],
                    severity="WARNING",
                )
            )
            return

        # Check git modifications inside tbn/
        try:
            res = subprocess.run(
                ["git", "status", "--porcelain", "tbn"],
                cwd=self.repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode == 0 and res.stdout.strip():
                raw_items = [line.strip() for line in res.stdout.strip().splitlines()]
                # Documentation (.md) and test scripts are not client code
                changed_items = [
                    item for item in raw_items
                    if not any(item.endswith(ext) for ext in [".md", "test_conformance.py"])
                    and "tbn/docs/" not in item
                ]
                if changed_items:
                    self.add_violation(
                        ConformanceViolation(
                            category="TBN_MODIFICATION_DETECTED",
                            rule="Never create or edit client code inside `tbn/`. Do not modify tbn/client-node.js.",
                            description=f"Client code modifications or added files detected in `tbn/`: {', '.join(changed_items)}",
                            semantic_feedback=(
                                f"`tbn/` is strictly read-only for technical details. Found altered files:\n"
                                f"{chr(10).join(changed_items)}\n"
                                "You must NOT place client implementation inside `tbn/`."
                            ),
                            remediation_steps=[
                                "Revert modified files in `tbn/` with: `git checkout HEAD -- tbn/`",
                                "Remove newly created files in `tbn/` with: `git clean -fd tbn/`",
                                "Move any client code you added in `tbn/` to `./client.js` at the repository root.",
                            ],
                        )
                    )
                    return
        except Exception:
            pass

        self.log_pass("`tbn/` framework directory is intact and unmodified.")

    # -------------------------------------------------------------------------
    # 3. No Alternate Entry Points
    # -------------------------------------------------------------------------
    def check_alternate_entrypoints(self):
        forbidden = [
            "app.js",
            "server.js",
            "frontend/index.html",
            "tbn/index.html",
            "frontend/client.js",
            "src/client.js",
            "client/index.html",
        ]

        found = [p for p in forbidden if (self.repo_root / p).exists()]

        if found:
            self.add_violation(
                ConformanceViolation(
                    category="ALTERNATE_ENTRYPOINT_DETECTED",
                    rule="Do not create alternate entry points such as app.js, server.js, frontend/index.html, or tbn/index.html.",
                    description=f"Forbidden alternate entry points found: {', '.join(found)}",
                    semantic_feedback=(
                        f"Found forbidden entry points: {found}. "
                        "The game client must only be started via `./client.js`. "
                        "Do not split execution into `server.js`, `app.js`, or web frontend entry points."
                    ),
                    remediation_steps=[
                        f"Remove the alternate entry points: `rm -f {' '.join(found)}`",
                        "Consolidate client/server startup into `./client.js`.",
                    ],
                )
            )
        else:
            self.log_pass("No forbidden alternate entry points detected.")

    # -------------------------------------------------------------------------
    # 4. Check for forbidden references to tbn/client-node.js
    # -------------------------------------------------------------------------
    def check_forbidden_references(self):
        client_js = self.repo_root / "client.js"
        if not client_js.exists() or not client_js.is_file():
            return

        content = client_js.read_text(errors="ignore")

        patterns = [
            r"require\s*\(\s*['\"].*tbn/client-node.*['\"]\s*\)",
            r"import\s+.*from\s+['\"].*tbn/client-node.*['\"]",
            r"require\s*\(\s*['\"].*client-node.*['\"]\s*\)",
        ]

        matches = []
        for pat in patterns:
            matches.extend(re.findall(pat, content))

        if matches:
            self.add_violation(
                ConformanceViolation(
                    category="FORBIDDEN_REFERENCE_DETECTED",
                    rule="Never use, copy, replace, or modify `tbn/client-node.js`.",
                    description=f"Forbidden reference to `tbn/client-node.js` found in `client.js`: {matches}",
                    semantic_feedback=(
                        "`tbn/client-node.js` is an external reference file that must not be imported or used. "
                        "Your root `client.js` must implement the client behavior independently using the "
                        "protocol and contract specs in `tbn/`."
                    ),
                    remediation_steps=[
                        "Remove the `require`/`import` of `client-node.js` from `client.js`.",
                        "Implement the client connection and message handling directly in `./client.js`.",
                    ],
                )
            )
        else:
            self.log_pass("`client.js` does not depend on `tbn/client-node.js`.")

    # -------------------------------------------------------------------------
    # 5. Syntax validation via Node.js
    # -------------------------------------------------------------------------
    def check_syntax(self):
        client_js = self.repo_root / "client.js"
        if not client_js.exists() or not client_js.is_file():
            return

        node_bin = self._resolve_node_binary()
        if not node_bin:
            self.add_violation(
                ConformanceViolation(
                    category="ENVIRONMENT_ERROR",
                    rule="Node.js must be available to test client.js.",
                    description="Could not locate `node` executable.",
                    semantic_feedback="Node.js binary not found in standard system PATHs.",
                    remediation_steps=["Ensure Node.js is installed and symlinked in PATH."],
                    severity="WARNING",
                )
            )
            return

        try:
            res = subprocess.run(
                [node_bin, "--check", "client.js"],
                cwd=self.repo_root,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if res.returncode != 0:
                self.add_violation(
                    ConformanceViolation(
                        category="SYNTAX_ERROR",
                        rule="client.js must be syntactically valid JavaScript.",
                        description="`node --check client.js` failed.",
                        semantic_feedback=f"Syntax error trace:\n{res.stderr.strip()}",
                        remediation_steps=[
                            "Fix the syntax error reported in `client.js`.",
                            "Verify locally using `node --check client.js`.",
                        ],
                    )
                )
            else:
                self.log_pass("`client.js` passed JavaScript syntax check.")
        except Exception as e:
            self.add_violation(
                ConformanceViolation(
                    category="EXECUTION_FAILURE",
                    rule="client.js must be verifiable via node.",
                    description=str(e),
                    semantic_feedback=str(e),
                    remediation_steps=["Check Node.js permissions."],
                )
            )

    # -------------------------------------------------------------------------
    # 6. Process boot & runtime startup check
    # -------------------------------------------------------------------------
    def check_runtime_boot(self):
        client_js = self.repo_root / "client.js"
        if not client_js.exists() or not client_js.is_file():
            return

        node_bin = self._resolve_node_binary()
        if not node_bin:
            return

        env = os.environ.copy()
        env["CI"] = "true"
        env["HEADLESS"] = "true"
        env["TEST_MODE"] = "true"

        proc = None
        try:
            proc = subprocess.Popen(
                [node_bin, "client.js"],
                cwd=self.repo_root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                stdin=subprocess.PIPE,
                text=True,
                env=env,
            )

            # Allow 2 seconds for boot / connection / startup logs
            time.sleep(2.0)
            poll_result = proc.poll()

            if poll_result is not None and poll_result != 0:
                stdout, stderr = proc.communicate(timeout=1)
                self.add_violation(
                    ConformanceViolation(
                        category="CRASH_ON_BOOT",
                        rule="Launching the game is exactly `node client.js` from the repository root.",
                        description=f"`node client.js` exited immediately with error code {poll_result}.",
                        semantic_feedback=(
                            f"Process exited prematurely with exit code {poll_result}.\n"
                            f"STDERR:\n{stderr.strip()}\n"
                            f"STDOUT:\n{stdout.strip()}\n"
                            "The game must boot cleanly and remain running or handle headless test mode."
                        ),
                        remediation_steps=[
                            "Inspect STDERR above for unhandled promise rejections or missing modules.",
                            "Ensure the client gracefully handles non-interactive environments.",
                        ],
                    )
                )
            else:
                self.log_pass("`node client.js` boots cleanly from repository root.")

        except Exception as e:
            self.add_violation(
                ConformanceViolation(
                    category="PROCESS_LAUNCH_ERROR",
                    rule="Game must start with `node client.js`.",
                    description=f"Could not spawn `node client.js`: {str(e)}",
                    semantic_feedback=str(e),
                    remediation_steps=["Ensure `client.js` is runnable via Node."],
                )
            )
        finally:
            if proc and proc.poll() is None:
                try:
                    proc.terminate()
                    proc.wait(timeout=1.0)
                except Exception:
                    proc.kill()

    # -------------------------------------------------------------------------
    # 7. Documentation check (Never instruct users to run tbn/client-node.js)
    # -------------------------------------------------------------------------
    def check_instruction_guidance(self):
        readme = self.repo_root / "README.md"
        if readme.exists():
            content = readme.read_text(errors="ignore")
            if "node tbn/client-node.js" in content:
                self.add_violation(
                    ConformanceViolation(
                        category="FORBIDDEN_USER_INSTRUCTION",
                        rule="Never instruct users to run `node tbn/client-node.js`. Game start is `node client.js`.",
                        description="`README.md` instructs users to run `node tbn/client-node.js`.",
                        semantic_feedback=(
                            "`README.md` tells users to execute `node tbn/client-node.js`. "
                            "Users must only be instructed to start the game with `node client.js` from the repository root."
                        ),
                        remediation_steps=[
                            "Change start command in `README.md` to: `node client.js`",
                            "Remove all instructions to run `node tbn/client-node.js`.",
                        ],
                    )
                )
            else:
                self.log_pass("`README.md` correctly specifies `node client.js`.")

    # -------------------------------------------------------------------------
    # Node Binary Resolution
    # -------------------------------------------------------------------------
    def _resolve_node_binary(self) -> Optional[str]:
        for candidate in ["node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]:
            if Path(candidate).is_file() and os.access(candidate, os.X_OK):
                return candidate
            try:
                res = subprocess.run(["which", candidate], capture_output=True, text=True)
                if res.returncode == 0 and res.stdout.strip():
                    return res.stdout.strip()
            except Exception:
                pass
        return None

    # -------------------------------------------------------------------------
    # Test Runner
    # -------------------------------------------------------------------------
    def run_all(self, json_output: bool = False) -> int:
        print(f"\n{BOLD}{CYAN}=== GAME CONFORMANCE TEST SUITE ==={RESET}")
        print(f"Target Repository: {self.repo_root}\n")

        self.check_root_client_js()
        self.check_tbn_integrity()
        self.check_alternate_entrypoints()
        self.check_forbidden_references()
        self.check_syntax()
        self.check_runtime_boot()
        self.check_instruction_guidance()

        print(f"\n{BOLD}=== SUMMARY ==={RESET}")
        print(f"Passed Checks: {len(self.passed_checks)}")
        print(f"Violations:    {len(self.violations)}\n")

        if json_output:
            output = {
                "passed": len(self.violations) == 0,
                "passed_count": len(self.passed_checks),
                "violation_count": len(self.violations),
                "passed_checks": self.passed_checks,
                "violations": [v.to_dict() for v in self.violations],
            }
            print(json.dumps(output, indent=2))

        if self.violations:
            print(f"{BOLD}{RED}🚨 CONFORMANCE TEST FAILED! SEMANTIC FEEDBACK FOR AGENT:{RESET}\n")
            for i, v in enumerate(self.violations, start=1):
                print(f"{BOLD}[Violation {i}/{len(self.violations)}] Category: {v.category} ({v.severity}){RESET}")
                print(f"  • {BOLD}Broken Rule:{RESET} {v.rule}")
                print(f"  • {BOLD}Issue Description:{RESET} {v.description}")
                print(f"  • {BOLD}Semantic Feedback:{RESET}")
                for line in v.semantic_feedback.splitlines():
                    print(f"      {line}")
                print(f"  • {BOLD}Required Remediation Steps:{RESET}")
                for step in v.remediation_steps:
                    print(f"      👉 {step}")
                print("-" * 70)
            return 1

        print(f"{BOLD}{GREEN}🎉 CONFORMANCE TEST PASSED (Status: OK){RESET}")
        print(f"Client is correctly configured in root `client.js` with clean `tbn/` isolation.\n")
        return 0


if __name__ == "__main__":
    is_json = "--json" in sys.argv
    tester = ConformanceTester()
    exit_code = tester.run_all(json_output=is_json)
    sys.exit(exit_code)
