#!/usr/bin/env python3
# mmatvei.ru HTTPS static server.
# Threaded so a single slow/stalled client can't block the whole site,
# with a socket timeout so half-open TLS handshakes get dropped instead
# of freezing the accept loop.

import ssl
import http.server

CERT = "/etc/letsencrypt/live/mmatvei.ru/fullchain.pem"
KEY  = "/etc/letsencrypt/live/mmatvei.ru/privkey.pem"
ADDR = ("", 443)

httpd = http.server.ThreadingHTTPServer(ADDR, http.server.SimpleHTTPRequestHandler)
httpd.daemon_threads = True

# Drop clients that connect but stall (the failure mode that hung the old
# single-threaded server). Applies to accept()/handshake on the listen socket.
httpd.socket.settimeout(20)

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(certfile=CERT, keyfile=KEY)
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

print("serving https on :443 (threaded)")
httpd.serve_forever()
