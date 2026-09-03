#!/usr/bin/env bash
# One-time host preparation for the Oracle Cloud Always Free reference host
# (Ubuntu 24.04, arm64 A1.Flex or x86 E2.1.Micro). Run as the default user:
#
#   curl -fsSL https://raw.githubusercontent.com/changminKo/moi/main/infra/oracle/bootstrap.sh | bash
#
# Creates a 4 GB swapfile (the E2.1.Micro fallback host has 1 GB of RAM),
# installs Docker + compose plugin, Node 24 + pnpm, sops and age, opens 80/443 in the OS
# firewall (Oracle images ship iptables rules that drop everything else),
# clones the repository to /opt/moi, prepares /etc/moi (age key, encrypted
# secrets, moi.env) and installs the systemd units (stack, status timer,
# failure alert). It never asks for or writes a secret: you place
# /etc/moi/secrets.enc.env yourself (see the deployment guide) and only then
# `systemctl start moi`.
set -euo pipefail

REPO="${MOI_REPO:-https://github.com/changminKo/moi.git}"
REF="${MOI_REF:-main}"
SOPS_VERSION="${SOPS_VERSION:-3.13.3}"

arch="$(dpkg --print-architecture)" # arm64 | amd64
echo "== packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git gnupg jq perl age util-linux netfilter-persistent iptables-persistent

echo "== docker (official repository)"
if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo usermod -aG docker "$USER"
fi

echo "== node 24 (for the preflight and the pnpm workspace on the host)"
if ! command -v node >/dev/null || ! node /dev/stdin <<'JS' 2>/dev/null
const [major, minor] = process.versions.node.split('.').map(Number);
process.exit(major === 24 && minor >= 19 ? 0 : 1);
JS
then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs
fi
sudo corepack enable
corepack prepare pnpm@11.22.0 --activate >/dev/null
node --version; pnpm --version

echo "== sops ${SOPS_VERSION}"
if ! command -v sops >/dev/null; then
  curl -fsSL -o /tmp/sops.deb "https://github.com/getsops/sops/releases/download/v${SOPS_VERSION}/sops_${SOPS_VERSION}_${arch}.deb"
  sudo dpkg -i /tmp/sops.deb && rm /tmp/sops.deb
fi

echo "== swap (4 GB): the E2.1.Micro fallback host has 1 GB of RAM"
if ! sudo swapon --show=NAME --noheadings | grep -qx /swapfile; then
  sudo fallocate -l 4G /swapfile 2>/dev/null || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
  sudo chmod 600 /swapfile
  sudo mkswap -q /swapfile
  sudo swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
# A 1 GB host must start swapping early, otherwise the OOM killer wins first.
printf 'vm.swappiness=80\nvm.vfs_cache_pressure=50\n' | sudo tee /etc/sysctl.d/99-moi-swap.conf >/dev/null
sudo sysctl -q --system
free -h

echo "== firewall: allow 80/443 (Oracle images drop them by default)"
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT 2>/dev/null; then
    # Insert at the top: Oracle images end the chain with REJECT, and any
    # assumed position could land behind it.
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
  fi
done
sudo netfilter-persistent save >/dev/null

echo "== repository at /opt/moi (${REF})"
if [ ! -d /opt/moi/.git ]; then
  sudo git clone --branch "$REF" "$REPO" /opt/moi
  sudo chown -R "$USER":"$USER" /opt/moi
else
  git -C /opt/moi fetch -q origin && git -C /opt/moi checkout -q "$REF" && git -C /opt/moi pull -q --ff-only
fi

echo "== /etc/moi (root only; reruns never replace an existing identity or config)"
sudo install -d -m 0700 -o root -g root /etc/moi
if ! sudo test -f /etc/moi/age.key; then
  # Generate into a root-only temp file and install atomically; the private
  # key never exists with looser permissions, and an existing key is kept.
  tmp="$(sudo mktemp /etc/moi/.age.XXXXXX)"
  sudo sh -c "umask 077; age-keygen > '$tmp' 2>/dev/null"
  sudo grep -q '^AGE-SECRET-KEY-' "$tmp" || { echo "age-keygen produced no key"; sudo rm -f "$tmp"; exit 1; }
  sudo install -m 0600 -o root -g root "$tmp" /etc/moi/age.key && sudo rm -f "$tmp"
fi
if ! sudo test -f /etc/moi/moi.env; then
  sudo tee /etc/moi/moi.env >/dev/null <<'ENV'
# Non-secret settings for the compose stack (systemd EnvironmentFile).
WEB_DOMAIN=app.example.com
API_DOMAIN=api.example.com
# MOI_IMAGE_TAG=<commit sha>   # pin a published image to roll back
# COMPOSE_PROFILES=bot          # start the strategy runner with the stack (needs infra/bot/runner.json and DISCORD_WEBHOOK_TRADE_URL)
ENV
  sudo chmod 0600 /etc/moi/moi.env
fi
sudo install -m 0644 /opt/moi/infra/oracle/*.service /opt/moi/infra/oracle/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable moi >/dev/null
# Status timer (Discord on change): enabled here, started by the first
# deploy.sh once a release is serving — a no-op until DISCORD_WEBHOOK_URL is in
# the sops file.
sudo systemctl enable moi-status.timer >/dev/null

echo
echo "Host age public key (encrypt /etc/moi/secrets.enc.env for it):"
sudo grep -o 'age1[0-9a-z]*' /etc/moi/age.key | head -1
echo
echo "Next: edit /etc/moi/moi.env (sudo), place /etc/moi/secrets.enc.env, register this"
echo "host's public IP with Toss and in infra/provider-allowlist.yaml, then run"
echo "sudo /opt/moi/infra/oracle/deploy.sh. Log out and back in once for docker group membership."
