import http.server
import json
import os
import re
import socketserver
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin

PORT = 8965
WEBAPP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(WEBAPP_DIR, "link-vault-data.json")


class MetaParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.og_image = None
        self.twitter_image = None
        self.title = None
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            prop = (attrs.get("property") or "").lower()
            name = (attrs.get("name") or "").lower()
            content = attrs.get("content")
            if prop == "og:image" and content and not self.og_image:
                self.og_image = content
            if name == "twitter:image" and content and not self.twitter_image:
                self.twitter_image = content
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title and not self.title:
            self.title = data.strip()


def fetch_preview(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; LinkVaultBot/1.0)"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        content_type = resp.headers.get("Content-Type", "")
        if "text/html" not in content_type:
            return {}
        raw = resp.read(3_000_000)
        charset = "utf-8"
        m = re.search(r"charset=([\w-]+)", content_type)
        if m:
            charset = m.group(1)
        html = raw.decode(charset, errors="replace")

    parser = MetaParser()
    parser.feed(html)
    image = parser.og_image or parser.twitter_image or ""
    if image:
        image = urljoin(url, image)
    return {"image": image, "title": parser.title or ""}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEBAPP_DIR, **kwargs)

    def log_message(self, format, *args):
        pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/api/data":
            if os.path.exists(DATA_FILE):
                try:
                    with open(DATA_FILE, encoding="utf-8") as f:
                        items = json.load(f)
                except Exception:
                    items = []
                self._send_json({"exists": True, "items": items})
            else:
                self._send_json({"exists": False, "items": []})
            return
        super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        if self.path == "/api/data":
            try:
                items = json.loads(body)
                if not isinstance(items, list):
                    raise ValueError("Payload must be a JSON array")
                with open(DATA_FILE, "w", encoding="utf-8") as f:
                    json.dump(items, f, ensure_ascii=False, indent=2)
                self._send_json({"ok": True})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)}, status=400)
            return

        if self.path == "/api/fetch-preview":
            try:
                payload = json.loads(body)
                url = payload.get("url", "")
                if not url:
                    raise ValueError("missing url")
                preview = fetch_preview(url)
                self._send_json({"ok": True, **preview})
            except Exception as e:
                self._send_json({"ok": False, "error": str(e)})
            return

        self.send_response(404)
        self.end_headers()


class ThreadingServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    import webbrowser

    with ThreadingServer(("127.0.0.1", PORT), Handler) as httpd:
        url = f"http://localhost:{PORT}/"
        print(f"Link Vault server running at {url}")
        print(f"Data file: {DATA_FILE}")
        print("Press Ctrl+C to stop.")
        try:
            webbrowser.open(url)
        except Exception:
            pass
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
