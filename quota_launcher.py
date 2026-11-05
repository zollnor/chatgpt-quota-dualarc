"""Start the official ChatGPT app and apply a quota-only DOM customization.

Uses anonymous inherited pipes. No TCP listener, app-package writes, credential
reads, third-party service, or persistent OS background task.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent
STATE = ROOT / "state"
MUTEX_NAME = "Local\\ChatGPTQuotaDualArc_v1"

# Only inspect the known quota control. Do not collect page text, titles, URLs,
# descriptions containing numbers, React props, or account/chat information.
QUOTA_PROBE = r"""(() => {
  const labels = new Set(['用量','Usage','使用情况','使用情況']);
  const rect = e => { const b=e.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height}; };
  const css = e => {const s=getComputedStyle(e);return {display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,color:s.color,stroke:s.stroke};};
  const buttons = Array.from(document.querySelectorAll('button[aria-label]')).filter(e=>labels.has(e.getAttribute('aria-label')));
  return {status:globalThis.__chatgptQuotaDualArc?.inspect()?.status ?? 'waiting-for-page',
    ready:document.readyState,visibility:document.visibilityState,
    viewport:{width:innerWidth,height:innerHeight},frameCount:document.querySelectorAll('iframe').length,
    quotaCount:buttons.length,buttons:buttons.slice(0,3).map(b=>({rect:rect(b),style:css(b),
      svgs:Array.from(b.querySelectorAll('svg')).slice(0,5).map(s=>({custom:s.hasAttribute('data-quota-dual-arc'),
        rect:rect(s),style:css(s),parentTag:s.parentElement?.tagName,parentRect:s.parentElement?rect(s.parentElement):null,
        pathCount:s.querySelectorAll('path[pathLength="100"]').length}))}))};
})()"""


def combined_state(pages):
    states = [page.get("status", "waiting-for-page") for page in pages]
    for preferred in ("applied", "applied-with-unknown-window", "skipped-unrecognized-quota-structure", "skipped-ambiguous-buttons"):
        if preferred in states:
            return preferred
    for state in states:
        if isinstance(state,str) and state.startswith("skipped-"):
            return state
    return states[0] if states else "waiting-for-page"


class PipeError(RuntimeError):
    pass


class PrivatePipe:
    """One authenticated-by-handle-inheritance connection to a child process."""

    def __init__(self, executable: Path, profile: Path | None = None):
        import msvcrt

        child_read, self._write = os.pipe()
        self._read, child_write = os.pipe()
        handles = [msvcrt.get_osfhandle(child_read), msvcrt.get_osfhandle(child_write)]
        for handle in handles:
            os.set_handle_inheritable(handle, True)
        startup = subprocess.STARTUPINFO()
        startup.lpAttributeList = {"handle_list": handles}
        command = [str(executable), "--remote-debugging-pipe",
                   f"--remote-debugging-io-pipes={handles[0]},{handles[1]}"]
        environment = dict(os.environ)
        if profile is not None:
            profile = profile.resolve()
            profile.mkdir(parents=True, exist_ok=True)
            environment["CODEX_ELECTRON_USER_DATA_PATH"] = str(profile)
            command.append(f"--user-data-dir={profile}")
        self._condition = threading.Condition()
        self._responses: dict[int, dict] = {}
        self._closed = False
        self._sequence = 0
        try:
            self.process = subprocess.Popen(
                command, env=environment, startupinfo=startup, close_fds=True,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception:
            os.close(self._read)
            os.close(self._write)
            raise
        finally:
            os.close(child_read)
            os.close(child_write)
        threading.Thread(target=self._reader, name="quota-private-pipe", daemon=True).start()

    def _reader(self):
        buffer = b""
        try:
            while True:
                chunk = os.read(self._read, 65536)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > 32 * 1024 * 1024:
                    raise PipeError("Unexpectedly large runtime response")
                while b"\0" in buffer:
                    packet, buffer = buffer.split(b"\0", 1)
                    if not packet:
                        continue
                    response = json.loads(packet)
                    if "id" in response:
                        with self._condition:
                            self._responses[response["id"]] = response
                            self._condition.notify_all()
        except (OSError, ValueError, PipeError):
            pass
        finally:
            with self._condition:
                self._closed = True
                self._condition.notify_all()
            os.close(self._read)

    def call(self, method: str, params: dict | None = None, *, session: str | None = None, timeout: float = 15):
        with self._condition:
            self._sequence += 1
            ident = self._sequence
            request = {"id": ident, "method": method, "params": params or {}}
            if session:
                request["sessionId"] = session
            data = json.dumps(request, separators=(",", ":")).encode("utf-8") + b"\0"
            try:
                offset = 0
                while offset < len(data):
                    offset += os.write(self._write, data[offset:])
            except OSError as error:
                raise PipeError("Private connection closed") from error
            deadline = time.monotonic() + timeout
            while ident not in self._responses:
                remaining = deadline - time.monotonic()
                if self._closed or remaining <= 0:
                    raise PipeError("Private connection closed or timed out")
                self._condition.wait(remaining)
            response = self._responses.pop(ident)
            if "error" in response:
                # Do not forward arbitrary app or page text into status files.
                raise PipeError(f"Runtime request failed ({response['error'].get('code', 'unknown')})")
            return response.get("result", {})

    def evaluate(self, expression: str, session: str):
        result = self.call("Runtime.evaluate", {"expression":expression,"returnByValue":True,"awaitPromise":True},session=session)
        if "exceptionDetails" in result:
            raise PipeError("Quota customization could not execute")
        return result.get("result", {}).get("value")

    def app_targets(self):
        result = self.call("Target.getTargets")
        # Never retain, print, or persist page titles or other pages' URLs.
        return [target["targetId"] for target in result.get("targetInfos", [])
                if target.get("type") == "page" and is_app_url(target.get("url", ""))]

    def close_test_instance(self):
        try:
            self.call("Browser.close", timeout=4)
        except PipeError:
            pass
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            # This method is used only by an explicitly isolated test instance.
            subprocess.run(["taskkill.exe", "/PID", str(self.process.pid), "/T", "/F"],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=False)
        self.disconnect()

    def disconnect(self):
        try:
            os.close(self._write)
        except OSError:
            pass


def is_app_url(url: str) -> bool:
    from urllib.parse import urlsplit
    try:
        parsed = urlsplit(url)
        return parsed.scheme == "app" and parsed.netloc == "-"
    except ValueError:
        return False


def discover_app() -> Path:
    powershell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    query = ("$p=Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1;"
             "if($p){[Console]::OutputEncoding=[Text.Encoding]::UTF8;[Console]::Write($p.InstallLocation)}")
    result = subprocess.run([str(powershell), "-NoProfile", "-NonInteractive", "-Command", query],
                            capture_output=True, timeout=20, creationflags=subprocess.CREATE_NO_WINDOW,
                            check=True)
    location = Path(result.stdout.decode("utf-8-sig").strip())
    if not location.is_absolute() or not location.name.startswith("OpenAI.Codex_"):
        raise PipeError("Official installed package was not found")
    executable = location / "app/ChatGPT.exe"
    if not executable.is_file() or not (location / "app/resources/app.asar").is_file():
        raise PipeError("Official application layout is not recognized")
    return executable


def status(state: str, **safe_fields):
    STATE.mkdir(exist_ok=True)
    payload = {"time":datetime.now(timezone.utc).isoformat(),"state":state,**safe_fields}
    temporary = STATE / "status.tmp"
    temporary.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding="utf-8")
    temporary.replace(STATE / "status.json")


def message(text: str):
    import ctypes
    ctypes.windll.user32.MessageBoxW(None,text,"ChatGPT 额度双弧",0x40)


def run():
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateMutexW.argtypes = [ctypes.c_void_p,wintypes.BOOL,wintypes.LPCWSTR]
    kernel.CreateMutexW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex = kernel.CreateMutexW(None,False,MUTEX_NAME)
    if ctypes.get_last_error() == 183:
        kernel.CloseHandle(mutex)
        return
    client = None
    sessions = {}
    scripts = {}
    try:
        executable = discover_app()
        source = (ROOT / "dual-arc.js").read_text(encoding="utf-8")
        source_stamp = (ROOT / "dual-arc.js").stat().st_mtime_ns
        stop = STATE / "stop.request"
        if stop.exists():
            stop.unlink()
        status("starting",package=executable.parent.parent.name)
        client = PrivatePipe(executable)
        try:
            client.call("Browser.getVersion", timeout=20)
        except PipeError:
            status("needs-fresh-launch")
            message("请先从托盘菜单完全退出 ChatGPT，再打开“ChatGPT 额度双弧”。\n\n当前窗口由普通入口启动，无法接入本次私有管道。启动器不会强制关闭你的会话。")
            return
        last_status = None
        found_target = False
        while client.process.poll() is None and not stop.exists():
            try:
                targets = client.app_targets()
                found_target = found_target or bool(targets)
                updated_stamp = (ROOT / "dual-arc.js").stat().st_mtime_ns
                if updated_stamp != source_stamp:
                    source = (ROOT / "dual-arc.js").read_text(encoding="utf-8")
                    source_stamp = updated_stamp
                    for session in sessions.values():
                        client.evaluate("globalThis.__chatgptQuotaDualArc?.uninstall()",session)
                        identifier = scripts.pop(session,None)
                        if identifier:
                            client.call("Page.removeScriptToEvaluateOnNewDocument",{"identifier":identifier},session=session)
                    sessions.clear()
                page_states = []
                for target in targets:
                    if target not in sessions:
                        session = client.call("Target.attachToTarget",{"targetId":target,"flatten":True})["sessionId"]
                        client.call("Page.enable",session=session)
                        script = client.call("Page.addScriptToEvaluateOnNewDocument",{"source":source},session=session)
                        scripts[session] = script["identifier"]
                        client.evaluate(source,session)
                        sessions[target] = session
                    page_probe = client.evaluate(QUOTA_PROBE,sessions[target])
                    page_states.append(page_probe)
                result = combined_state(page_states)
                safe_snapshot = json.dumps([result,page_states],sort_keys=True)
                if safe_snapshot != last_status:
                    status(result,package=executable.parent.parent.name,pages=page_states)
                    last_status = safe_snapshot
                for target in set(sessions) - set(targets):
                    sessions.pop(target,None)
            except PipeError:
                # Windows can navigate or reload between discovery and evaluation.
                sessions.clear()
                if client.process.poll() is not None:
                    break
            time.sleep(2)
        if not found_target and not stop.exists():
            status("needs-fresh-launch")
            message("请先从托盘菜单完全退出 ChatGPT，再打开“ChatGPT 额度双弧”。\n\n启动器不会强制关闭当前会话。")
        else:
            status("stopped")
    except Exception as error:
        status("error",kind=type(error).__name__)
        message("双弧定制没有启用。官方安装包保持原样，可继续从原来的入口使用 ChatGPT。\n\n请查看本文件夹的 state\\status.json；日志不记录聊天或登录信息。")
    finally:
        if client:
            for session, identifier in scripts.items():
                try:
                    client.call("Page.removeScriptToEvaluateOnNewDocument",{"identifier":identifier},session=session,timeout=3)
                    client.evaluate("globalThis.__chatgptQuotaDualArc?.uninstall()",session)
                except PipeError:
                    pass
            client.disconnect()
        kernel.CloseHandle(mutex)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stop",action="store_true",help="Restore stock quota UI without closing ChatGPT")
    args = parser.parse_args()
    if args.stop:
        STATE.mkdir(exist_ok=True)
        (STATE / "stop.request").touch()
    else:
        run()
