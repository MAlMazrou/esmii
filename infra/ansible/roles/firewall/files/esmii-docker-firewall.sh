#!/bin/sh
set -eu

ensure_jump() {
  binary="$1"
  "$binary" -N ESMII-INGRESS 2>/dev/null || true
  "$binary" -C DOCKER-USER -j ESMII-INGRESS 2>/dev/null || "$binary" -I DOCKER-USER 1 -j ESMII-INGRESS
  "$binary" -F ESMII-INGRESS
  "$binary" -A ESMII-INGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "$binary" -A ESMII-INGRESS -p tcp -m conntrack --ctorigdstport 80 -j RETURN
  "$binary" -A ESMII-INGRESS -p tcp -m conntrack --ctorigdstport 443 -j RETURN
  "$binary" -A ESMII-INGRESS -p udp -m conntrack --ctorigdstport 443 -j RETURN
  "$binary" -A ESMII-INGRESS -j DROP
}

ensure_jump /usr/sbin/iptables
if [ -x /usr/sbin/ip6tables ]; then
  ensure_jump /usr/sbin/ip6tables
fi

