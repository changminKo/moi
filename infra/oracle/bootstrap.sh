#!/usr/bin/env bash
# One-time host preparation for the Oracle Cloud Always Free reference host
# (Ubuntu 24.04, arm64 A1.Flex or x86 E2.1.Micro). Run as the default user:
#
#   curl -fsSL https://raw.githubusercontent.com/changminKo/moi/main/infra/oracle/bootstrap.sh | bash
#
# Installs Docker + compose plugin, Node 24 + pnpm, sops and age, opens 80/443 in the OS
# firewall (Oracle images ship iptables rules that drop everything else),
# clones the repository to /opt/moi, prepares /etc/moi (age key, encrypted
# secrets, moi.env) and installs the systemd unit. It never asks for or writes
# a secret: you place /etc/moi/secrets.enc.env yourself (see the deployment
# guide) and only then `systemctl start moi`.
set -euo pipefail

REPO="${MOI_REPO:-https://github.com/changminKo/moi.git}"
REF="${MOI_REF:-main}"
SOPS_VERSION="${SOPS_VERSION:-3.13.3}"

arch="$(dpkg --print-architecture)" # arm64 | amd64
echo "== packages"
sudo apt-get update -qq
sudo apt-get install -y -qq ca-certificates curl git gnupg age netfilter-persistent iptables-persistent

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
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "24" ]; then
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

echo "== /etc/moi"
sudo install -d -m 0700 -o root -g root /etc/moi
if [ ! -f /etc/moi/age.key ]; then
  # The host's own age identity. Encrypt the secrets file for THIS public key.
  umask 077
  age-keygen 2>/dev/null | sudo tee /etc/moi/age.key >/dev/null
  sudo chmod 0600 /etc/moi/age.key
fi
if [ ! -f /etc/moi/moi.env ]; then
  sudo tee /etc/moi/moi.env >/dev/null <<'ENV'
# Non-secret settings for the compose stack (systemd EnvironmentFile).
WEB_DOMAIN=app.example.com
API_DOMAIN=api.example.com
ENV
fi
sudo install -m 0644 /opt/moi/infra/oracle/moi.service /etc/systemd/system/moi.service
sudo systemctl daemon-reload
sudo systemctl enable moi >/dev/null

echo
echo "Host age public key (encrypt /etc/moi/secrets.enc.env for it):"
sudo grep -o 'age1[0-9a-z]*' /etc/moi/age.key | head -1
echo
echo "Next: edit /etc/moi/moi.env, place /etc/moi/secrets.enc.env, register this"
echo "host's public IP with Toss and in infra/provider-allowlist.yaml, then run"
echo "infra/oracle/deploy.sh. Log out and back in once for docker group membership."
