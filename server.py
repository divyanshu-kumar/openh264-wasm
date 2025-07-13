import http.server
import socketserver

PORT = 8000

class MyHttpRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # These headers are essential for SharedArrayBuffer to work.
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

Handler = MyHttpRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print("--- COEP/COOP Server Running ---")
    print(f"Serving at: http://localhost:{PORT}")
    print("---------------------------------")
    httpd.serve_forever()
