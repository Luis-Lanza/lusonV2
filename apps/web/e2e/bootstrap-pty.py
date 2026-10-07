"""Private TEST-only controlling terminal driver; never prints terminal contents."""
import fcntl
import json
import os
import pty
import select
import signal
import sys
import termios
import time


def run():
    if len(sys.argv) != 2:
        raise RuntimeError("bootstrap binary required")
    with os.fdopen(3, "r") as private_input:
        accounts = json.load(private_input)
    if len(accounts) != 3:
        raise RuntimeError("three generated TEST accounts required")
    inputs = []
    for account in accounts:
        inputs.extend([account["username"], account["password"], account["password"]])
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
        os.execve(sys.argv[1], [sys.argv[1]], os.environ)
    os.close(slave)
    deadline = time.monotonic() + 60
    cancelled = False
    reaped = False
    count = 0
    buffer = b""

    def cancel(_signal, _frame):
        nonlocal cancelled
        cancelled = True

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    try:
        while time.monotonic() < deadline and not cancelled:
            result, status = os.waitpid(pid, os.WNOHANG)
            if result:
                reaped = True
                if not os.WIFEXITED(status) or os.WEXITSTATUS(status) != 0 or count != 9:
                    raise RuntimeError("private bootstrap failed")
                return
            ready, _, _ = select.select([master], [], [], 0.05)
            if ready:
                try:
                    data = os.read(master, 4096)
                except OSError:
                    data = b""
                buffer = (buffer + data)[-8192:]
            if count < 9 and prompts[count] in buffer:
                # ReadPassword prints the prompt before switching echo off. Wait for
                # actual terminal state, not a delay that could leak an input.
                if termios.tcgetattr(master)[3] & termios.ECHO:
                    continue
                os.write(master, inputs[count].encode("utf-8") + b"\n")
                count += 1
                buffer = b""
        raise RuntimeError("private bootstrap timed out or cancelled")
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
        # No exceptions, PTY bytes, usernames or account secrets reach logs.
        sys.stderr.write("Private TEST bootstrap failed.\n")
        sys.exit(1)
