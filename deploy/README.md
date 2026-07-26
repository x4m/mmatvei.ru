# Деплой mmatvei.ru

Сервер: `ssh mmm@mmatvei.ru`, сайт живёт в `/home/mmm/js` (это чекаут этой репы).

## Как устроено (с июля 2026)

- **nginx** отдаёт статику из `/home/mmm/js` и терминирует TLS.
  Конфиг: `deploy/nginx-mmatvei.ru.conf` → `/etc/nginx/sites-available/mmatvei.ru`.
  До этого статику раздавал самописный `server.py` (systemd-юнит `mmatvei-web`,
  теперь отключён) — он периодически зависал: TLS-хендшейк выполнялся в
  accept-цикле, и один зависший клиент блокировал весь сайт.
- **Сертификат** Let's Encrypt, продление: `certbot renew` (webroot `/home/mmm/js`),
  challenge отдаёт nginx с порта 80. Хук на перезагрузку nginx:
  `/etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh`.
- **Snake.io 3D** (`snake3d/`) — мультиплеер, Node-сервер в docker:

```bash
sudo docker run -d --name snake3d --restart unless-stopped \
  -p 127.0.0.1:8080:8080 \
  -v /home/mmm/js/snake3d:/app -w /app \
  node:20-alpine sh -c "npm install --omit=dev && exec node server.js"
```

  nginx проксирует `https://mmatvei.ru/snake3d/` (и `wss://.../snake3d/ws`)
  на этот контейнер. Профили игроков — в `snake3d/data.json` (в git не попадает).
- **Neon Labyrinth** (`shooter/`) — 3D-шутер, такой же Node-сервер в docker,
  порт 8081, проксируется через `/shooter/`:

```bash
sudo docker run -d --name shooter --restart unless-stopped \
  -p 127.0.0.1:8081:8080 -e SERVER_NAME="mmatvei.ru" \
  -v /home/mmm/js/shooter:/app -w /app \
  node:20-alpine sh -c "npm install --omit=dev && exec node server.js"
```

## Обновление сайта

```bash
ssh mmm@mmatvei.ru 'cd ~/js && git pull'
```

Статика подхватывается сразу. После изменения серверной части игр:
`sudo docker restart snake3d` / `sudo docker restart shooter`.
