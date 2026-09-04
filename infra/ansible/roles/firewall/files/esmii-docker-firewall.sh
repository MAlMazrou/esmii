#!/bin/sh
set -eu

ensure_jump() {
  binary="$1"
  "$binary" -N ESMII-INGRESS 2>/dev/null || true
  "$binary" -C DOCKER-USER -j ESMII-INGRESS 2>/dev/null || "$binary" -I DOCKER-USER 1 -j ESMII-INGRESS
  "$binary" -F ESMII-INGRESS
  "$binary" -A ESMII-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  for network_id in $(/usr/bin/docker network ls --filter 'label=com.docker.compose.project=esmii' --format '{{.ID}}'); do
    driver=$(/usr/bin/docker network inspect --format '{{.Driver}}' "$network_id")
    [ "$driver" = bridge ] || continue
    bridge=$(/usr/bin/docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$network_id")
    [ -n "$bridge" ] || bridge="br-$(printf '%s' "$network_id" | cut -c1-12)"
    "$binary" -A ESMII-INGRESS -i "$bridge" -o "$bridge" -j RETURN
  done
  "$binary" -A ESMII-INGRESS -p tcp -m conntrack --ctorigdstport 80 -j RETURN
  "$binary" -A ESMII-INGRESS -p tcp -m conntrack --ctorigdstport 443 -j RETURN
  "$binary" -A ESMII-INGRESS -p udp -m conntrack --ctorigdstport 443 -j RETURN
  "$binary" -A ESMII-INGRESS -p tcp -m conntrack --ctorigdstport 25 -j RETURN
  "$binary" -A ESMII-INGRESS -j DROP
}

ensure_jump /usr/sbin/iptables
if [ -x /usr/sbin/ip6tables ]; then
  ensure_jump /usr/sbin/ip6tables
fi
