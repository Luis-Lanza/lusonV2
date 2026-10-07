"""External verifier only: controlling PTY for the unchanged container CLI.

Generated TEST inputs arrive through fd3, not argv/environment. No terminal
bytes or exception details are emitted. Docker CLI and its descendants belong
only to this helper; never target another process or use a project selector.
"""
import fcntl
import json
import os
import pty
import re
import select
import signal
import sys
import termios
import time


def run():
    if len(sys.argv) != 3 or not re.fullmatch(r"[a-f0-9]{64}", sys.argv[1]) or sys.argv[2] not in ("initial", "replay"):
        raise RuntimeError("exact owned ID and mode required")
    with os.fdopen(3, "r") as private_input:
        accounts = json.load(private_input)
    if len(accounts) != 3 or len({a["username"] for a in accounts}) != 3 or len({a["password"] for a in accounts}) != 3:
        raise RuntimeError("distinct generated TEST inputs required")
    inputs = []
    for account in accounts:
        inputs.extend([account["username"], account["password"], account["password"]])
    if any("\n" in value or "\r" in value for value in inputs):
        raise RuntimeError("single-line generated inputs required")
    prompts = [b" username (hidden): ", b" password (hidden): ", b"Confirm password (hidden): "] * 3
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
        for descriptor in (0, 1, 2):
            os.dup2(slave, descriptor)
        if slave > 2:
            os.close(slave)
        os.execvp("docker", ["docker", "exec", "-it", sys.argv[1], "/usr/local/bin/bootstrap-accounts"])
    os.close(slave)
    deadline = time.monotonic() + 60
    cancelled = False
    reaped = False
    count = 0
    buffer = b""
    transcript = b""

    def cancel(_signal, _frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        while time.monotonic() < deadline and not cancelled:
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 4096)
                except OSError:
                    data = b""
                transcript += data
                if len(transcript) > 65536:
                    raise RuntimeError("bounded terminal output exceeded")
                buffer = (buffer + data)[-8192:]
                # Inspect privately: even generated usernames must not echo.
                if any(value.encode("utf-8") in transcript for value in inputs):
                    raise RuntimeError("hidden input echoed")
            if count < 9 and prompts[count] in buffer:
                # Docker sets the controlling terminal raw. The remote CLI
                # independently calls ReadPassword for every field; transcript
                # checks prove that no generated input was echoed.
                if termios.tcgetattr(master)[3] & termios.ECHO:
                    continue
                os.write(master, inputs[count].encode("utf-8") + b"\n")
                count += 1
                buffer = b""
            result, status = os.waitpid(pid, os.WNOHANG)
            if result:
                reaped = True
                successful = os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0
                expected = sys.argv[2] == "initial"
                marker = b"Three accounts provisioned." if expected else b"provisioning refused;"
                if count != 9 or successful != expected or marker not in transcript:
                    raise RuntimeError("private bootstrap result mismatch")
                return
        raise RuntimeError("bounded bootstrap interrupted")
    finally:
        try:
            termios.tcsetattr(master, termios.TCSANOW, original)
        except OSError:
            pass
        if not reaped:
            try:
                os.killpg(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            stop = time.monotonic() + 5
            while time.monotonic() < stop:
                result, _ = os.waitpid(pid, os.WNOHANG)
                if result:
                    reaped = True
                    break
                time.sleep(0.05)
            if not reaped:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.waitpid(pid, 0)
        os.close(master)
        for index in range(len(inputs)):
            inputs[index] = ""
        accounts.clear()


if __name__ == "__main__":
    try:
        run()
    except Exception:
        sys.stderr.write("Private L05 TEST bootstrap failed.\n")
        sys.exit(1)
