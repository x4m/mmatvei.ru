# taken from http://www.piware.de/2011/01/creating-an-https-server-in-python/
# generate server.pem with the following command:
#    openssl req -new -x509 -keyout key.pem -out server.pem -days 365 -nodes
# run as follows:
#    python simple-https-server.py
# then in your browser, visit:
#    https://localhost:4443


import http.server
import ssl

server_address = ('', 443)
httpd = http.server.HTTPServer(server_address, http.server.SimpleHTTPRequestHandler)
httpd.socket = ssl.wrap_socket(httpd.socket,
                               server_side=True,
                               certfile="/etc/letsencrypt/live/mmatvei.ru/fullchain.pem",
                               keyfile="/etc/letsencrypt/live/mmatvei.ru/privkey.pem",
                               ssl_version=ssl.PROTOCOL_TLS)
httpd.serve_forever()
