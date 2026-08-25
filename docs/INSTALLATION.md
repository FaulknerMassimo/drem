# Installing drem

This is the production installation guide. For a disposable development
environment, use [CONTRIBUTING.md](../CONTRIBUTING.md) instead; it runs against a
separate database cluster and a published development key.

drem requires Docker, Docker Compose, Node.js with npm, and Ollama on the host.
Ollama deliberately does not run in a container, so it retains direct GPU
access. It is the one component shared by production and development because it
holds models rather than journal data.

## Install the host services

Install Docker, Docker Compose, and Ollama using the packages for your system.
For example, to install and enable Docker on Arch Linux:

```bash
sudo pacman -S docker docker-compose        # adjust for your distro
sudo systemctl enable --now docker
sudo usermod -aG docker $USER               # log out and back in
```

Configure Ollama before pulling models. `ollama pull` asks the running server to
download a model, so starting the intended server first ensures the model lands
in the store that drem will actually use.

## Configure Ollama for Docker

Containers reach Ollama at `host.docker.internal:11434`, which Compose maps to
the Docker host gateway. Ollama binds `127.0.0.1:11434` by default, while that
gateway is normally `172.17.0.1`. A loopback-only socket therefore works for
`npm run dev` on the host but refuses the containerised production app.

On Linux, add a systemd override:

```bash
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Then enable and restart the service:

```bash
sudo systemctl enable ollama
sudo systemctl restart ollama
```

The restart is required even if Ollama is already running. `systemctl enable
--now` starts an inactive service but does not restart an active one, which
would keep its old loopback-only binding.

Binding to every interface also exposes Ollama's unauthenticated API to the
LAN. Fence port 11434 off to Docker's bridge networks. First run `ip -brief
addr` and confirm that `172.16.0.0/12` does not overlap your LAN; use a narrower
range if it does.

With ufw:

```bash
sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp comment 'ollama: docker only'
sudo ufw status verbose      # confirm "Default: deny (incoming)"
```

With firewalld:

```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=172.16.0.0/12 port port=11434 protocol=tcp accept'
sudo firewall-cmd --reload
```

On macOS the desktop app runs as your user and ignores the systemd instructions.
Set the launch-agent environment instead, then restart Ollama:

```bash
launchctl setenv OLLAMA_HOST 0.0.0.0:11434
```

## Pull the models

With the service running, pull the embedding model used by semantic search:

```bash
ollama pull embeddinggemma
```

`embeddinggemma:300m` produces the 768-dimensional vectors for which drem's
schema is configured. Pull any chat or vision models you need too, then assign
them to the other roles from the Settings screen.

### Where Ollama stores models

Models belong to the running server, not to the user who invokes `ollama pull`.
The packaged Linux service runs as the `ollama` system user and usually keeps
models under `/var/lib/ollama` or `/usr/share/ollama/.ollama`. An `ollama serve`
started from your shell uses `~/.ollama` instead.

This distinction explains the common case where `ollama list` once showed
models, but the newly enabled service appears empty. You can pull them again,
move them into the service's store, or point the service at the existing user
store.

### Reuse an existing user store

To run the service as your user and keep using `~/.ollama/models`, add the
following with `sudo systemctl edit ollama`, substituting your username for
`you`:

```ini
[Service]
Environment=
Environment="HOME=/home/you"
Environment="OLLAMA_MODELS=/home/you/.ollama/models"
Environment="OLLAMA_HOST=0.0.0.0:11434"
User=you
Group=you
ProtectHome=no
WorkingDirectory=/home/you
```

The bare `Environment=` is load-bearing: it clears assignments from the
packaged unit that may otherwise keep `HOME` and `OLLAMA_MODELS` pointed at
`/var/lib/ollama`. `ProtectHome=no` permits the service to read the selected
home directory. Restart Ollama after saving the override.

### Move existing models into the service store

First inspect `systemctl cat ollama` and confirm the service's
`OLLAMA_MODELS` directory. If it is `/var/lib/ollama`, copy the
content-addressed blobs and manifests while Ollama is stopped:

```bash
sudo systemctl stop ollama
sudo rsync -a ~/.ollama/models/blobs/ /var/lib/ollama/blobs/
sudo rsync -a ~/.ollama/models/manifests/ /var/lib/ollama/manifests/
sudo chown -R ollama:ollama /var/lib/ollama
sudo systemctl start ollama
ollama list
```

If the unit names a different `OLLAMA_MODELS` directory, use it as the copy
destination. Only after `ollama list` shows the migrated models, move the old
store aside so the operation remains recoverable:

```bash
mv ~/.ollama/models ~/.ollama/models.pre-service
```

Once drem has successfully used a migrated model, inspect and delete the
renamed directory to reclaim the duplicate space, substituting your username
for `you`:

```bash
du -sh /home/you/.ollama/models.pre-service
rm -rf /home/you/.ollama/models.pre-service
```

Do not delete all of `~/.ollama`; it may also hold the client's identity files.

### Delete models

Let the running Ollama server update its manifests and shared blobs rather than
deleting individual files:

```bash
ollama list
ollama rm embeddinggemma
ollama rm llama3.2
```

`ollama rm` affects only the running server's current store. If the service
points at `/var/lib/ollama`, it cannot remove an orphaned
`~/.ollama/models`; move and delete that directory separately after confirming
that the service has every model you need.

## Configure and start drem

Create the production environment file and generate its master key:

```bash
cp .env.example .env
npm run --silent keygen >> .env
```

Use `--silent`: npm otherwise appends its own command banner to `.env`. Never
generate a new `MASTER_KEY` for an installation that already has data; every
entry would become permanently unreadable.

Set `POSTGRES_PASSWORD` and `DATABASE_URL` in `.env`, keeping the passwords in
the two values consistent. Then start the production stack and apply its
migrations:

```bash
docker compose up -d
npm run db:migrate:prod
```

Use `db:migrate:prod`, not `db:migrate`: the unsuffixed command deliberately
targets the disposable development journal. See [CONTRIBUTING.md](../CONTRIBUTING.md)
for the complete separation between environments.

Docker Compose publishes drem on `43817` by default. Open
<http://localhost:43817>, create the single account, and save the TOTP recovery
codes when they are shown; they appear only once.

If you use plain HTTP, leave `APP_ORIGIN` exactly matching how you open the app,
including its scheme and host. `http://localhost:43817` and
`http://127.0.0.1:43817` are different origins and are not interchangeable for
CSRF validation. If you change `DREM_PORT`, change `APP_ORIGIN` to match. Behind
a reverse proxy, `APP_ORIGIN` is the proxy's public URL rather than the Docker
host port.

`APP_ORIGIN` names one canonical origin; it is not an allowlist. To open drem
from a phone on the local network, set it to the server's LAN address, for
example `http://192.168.1.221:43817`, restart the app container, and use that
same URL on the server itself. Form submissions from `http://localhost:43817`
will then be rejected because it is a different origin. Sessions are also
scoped to the hostname, so treating the two addresses as separate entry points
would require separate logins even if both were allowed.

For a stable multi-device setup, give the server a DHCP reservation and use one
name from local DNS, such as `drem.home.arpa`, on every device. Set
`APP_ORIGIN=http://drem.home.arpa:43817` and make sure that name resolves to the
server's LAN address from both the computer and the phone. Plain HTTP does not
protect journal content or session cookies while they travel across the local
network; use an HTTPS reverse proxy if that network is not fully trusted.

## Verify Ollama from every boundary

These checks should all report the same running Ollama server and model list:

```bash
ollama list
curl -s http://172.17.0.1:11434/api/version
docker compose exec app node -e \
  "fetch('http://host.docker.internal:11434/api/tags').then(r=>r.json()).then(d=>console.log(d.models.map(m=>m.name)))"
```

Port 11434 should be refused from other machines on the LAN. In drem, open
Settings, test the Ollama provider, and assign models to the roles you intend to
use. Assign `embeddinggemma` to the **Embedding** role to enable semantic
search; entries written before that assignment need one backfill from the
search page.

The app and its job status messages distinguish the most common failures:

| Message | Cause |
| --- | --- |
| `Could not reach 127.0.0.1:11434` | Nothing is listening; the service is not running |
| `Could not reach host.docker.internal:11434` | Ollama is running but still bound only to loopback |
| Reached Ollama, but it has no models pulled | The service is using a different model store from the server into which they were pulled |
| `The provider returned HTTP 404` | The model tag in Settings does not match `ollama list` |
| `… did not finish answering after 120s` | The server answered, but the model is slower than the job budget |

After installation, follow [the backup procedure](BACKUP.md) immediately.
`MASTER_KEY`, the database, and attachments have different backup requirements;
no one of them is sufficient by itself.
