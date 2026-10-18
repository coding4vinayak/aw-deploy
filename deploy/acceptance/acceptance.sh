#!/usr/bin/env bash
# acceptance.sh — post-deploy *behavioral* acceptance for the Abetworks fleet.
#
# smoke-test.sh answers "is it up". This answers "does it behave" — with no
# secrets needed, from the outside, the way a customer or an attacker sees it:
#
#   · every app host serves its front page
#   · every app host reports health with its database up (hub/pdf/tools
#     health-check `/` by design — a 404 on /api/health there is a skip)
#   · paid apps render /pricing + /signup and gate their dashboard route
#   · billing webhooks reject unsigned AND forged payloads (4xx — never 2xx/5xx)
#   · the API publishes its OpenAPI contract and refuses anonymous callers
#   · abetflow's workflow webhooks refuse a wrong secret
#   · the hub's owner route refuses no-token reads, /llms.txt keeps its
#     honesty line, and the UI carries no temporary *.onrender.com links
#   · every app host serves its discovery files — /llms.txt (the AI index)
#     and /robots.txt (pointing at the index where it is a static file)
#   · the marketing site's AI files serve once shipped (missing = skip, see
#     deploy/site-ai-pack), and its robots gains AI directives
#
# Usage:
#   bash acceptance.sh                 # the production hosts (blueprint domains)
#   bash acceptance.sh my-targets.txt  # "name type url [dashboard]" lines
#
# Types: site | lite | hub | paid | api | flow | pdf
# Exit: 0 = every checked invariant held; 1 = at least one FAIL.
set -uo pipefail

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s (%s)\n' "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m  %s (%s)\n' "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf '  \033[2mSKIP\033[0m  %s (%s)\n' "$1" "$2"; }

get_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" 2>/dev/null || echo 000; }
get_body() { curl -s --max-time 20 "$@" 2>/dev/null; }
post_code() { local url="$1"; shift; curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'content-type: application/json' "$@" "$url" 2>/dev/null || echo 000; }

is_4xx() { [ "${1:-000}" -ge 400 ] 2>/dev/null && [ "${1:-000}" -lt 500 ]; }
is_ok_or_redirect() { case "${1:-000}" in 2??|30?) return 0 ;; *) return 1 ;; esac; }

# Discovery files every shipped app host carries (the llms/robots/sitemap PRs).
# /llms.txt is the machine-readable index; /robots.txt must serve and — where
# it is a static public/ file — point at the index. Route-based robots (pdf,
# hub) can't carry comment lines, so the pointer check is skipped there.
check_discovery() {
  local base="$1" pointer="${2:-yes}"
  local c b
  c=$(get_code "$base/llms.txt"); b=$(get_body "$base/llms.txt")
  if [ "$c" = 200 ] && printf '%s' "$b" | head -1 | grep -q '^# '; then
    ok 'llms.txt serves the product index' "llms.txt → 200"
  else
    bad 'llms.txt serves the product index' "llms.txt → $c"
  fi
  c=$(get_code "$base/robots.txt"); b=$(get_body "$base/robots.txt")
  if [ "$c" != 200 ]; then
    bad 'robots.txt serves' "robots.txt → $c"
  elif [ "$pointer" = yes ]; then
    if printf '%s' "$b" | grep -q 'llms.txt'; then
      ok 'robots.txt points at the llms index' 'llms.txt mentioned'
    else
      bad 'robots.txt points at the llms index' 'served but no llms.txt mention'
    fi
  else
    ok 'robots.txt serves' 'robots.txt → 200 (route-based)'
  fi
  check_sitemap "$base"
}

# Every published app host must tell crawlers where its pages are. A sitemap
# that 404s or serves an empty urlset is the quiet half of the same failure as
# a dangling link card: nothing breaks in a browser, and search/AI discovery
# silently loses the pricing page.
check_sitemap() {
  local base="$1" c b n
  c=$(get_code "$base/sitemap.xml"); b=$(get_body "$base/sitemap.xml")
  if [ "$c" != 200 ]; then
    bad 'sitemap.xml serves' "sitemap.xml → $c"
    return
  fi
  if ! printf '%s' "$b" | grep -q '<urlset'; then
    bad 'sitemap.xml is a urlset' 'served but no <urlset>'
    return
  fi
  n=$(printf '%s' "$b" | grep -c '<loc>' || true)
  if [ "$n" -lt 1 ]; then
    bad 'sitemap.xml lists pages' 'served but no <loc>'
  else
    ok 'sitemap.xml serves the page list' "sitemap → 200, $n urls"
  fi
}

# The link card every public host should present: og:image must resolve to a
# real image — that's the first thing a prospect sees when the URL is shared
# in WhatsApp, email, or LinkedIn. Absolute (apps, via metadataBase) or
# relative (hub's and pdf's /og.png) both accepted. Fleet-wide since the free
# three joined: flow + api generate theirs, pdf ships a static one.
check_linkcard() {
  local base="$1" html og abs ct
  html=$(get_body "$base/")
  og=$(printf '%s' "$html" | grep -oE 'property="og:image" content="[^"]*"' | head -1 | sed -E 's/.*content="([^"]*)".*/\1/')
  if [ -z "$og" ]; then
    bad 'link card renders (og:image)' 'no og:image in the front page head'
    return
  fi
  case "$og" in
    http*) abs="$og" ;;
    *) abs="$base$og" ;;
  esac
  ct=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' --max-time 20 "$abs")
  if [ "$ct" = "200 image/png" ] || [ "$ct" = "200 image/jpeg" ]; then
    ok 'link card renders (og:image)' "serves $(printf '%s' "$ct" | cut -d' ' -f2)"
  else
    bad 'link card renders (og:image)' "$abs → $ct"
  fi
}

check_front() {
  local c; c=$(get_code "$1/")
  if is_ok_or_redirect "$c"; then ok 'front page serves' "$1/ → $c"; else bad 'front page serves' "$1/ → $c"; fi
}

# Health must say ok:true; when the route carries a db field, it must be "up".
check_health() {
  local c b; c=$(get_code "$1/api/health")
  if [ "$c" != 200 ]; then bad 'health answers 200' "api/health → $c"; return; fi
  b=$(get_body "$1/api/health")
  if ! printf '%s' "$b" | grep -q '"ok":true'; then bad 'health reports ok' "$(printf '%s' "$b" | head -c 90)"; return; fi
  if printf '%s' "$b" | grep -q '"db"'; then
    if printf '%s' "$b" | grep -q '"db":"up"'; then ok 'health: database up' '"db":"up"'; else bad 'health: database up' "$(printf '%s' "$b" | head -c 90)"; fi
  else
    ok 'health reports ok' 'no db field (file-based app)'
  fi
}

# Some hosts health-check the front page instead of exposing /api/health
# (hub and pdf declare `healthCheckPath: /`). A 404 there is a SKIP — but any
# other status (500, 503) is still a failure.
check_health_optional() {
  local c; c=$(get_code "$1/api/health")
  case "$c" in
    200) check_health "$1" ;;
    404) skip 'health route not exposed' 'api/health → 404 — front page is the health check (blueprint: healthCheckPath: /)' ;;
    *)   bad 'health answers 200' "api/health → $c" ;;
  esac
}

check_paid() {
  local base="$1" dash="$2"
  check_front "$base"; check_health "$base"
  local c
  c=$(get_code "$base/pricing")
  [ "$c" = 200 ] && ok 'pricing page serves' "/pricing → 200" || bad 'pricing page serves' "/pricing → $c"
  c=$(get_code "$base/signup")
  [ "$c" = 200 ] && ok 'signup page serves' "/signup → 200" || bad 'signup page serves' "/signup → $c"
  c=$(get_code "$base$dash")
  if [ "$c" = 307 ] || [ "$c" = 302 ] || [ "$c" = 303 ]; then
    ok 'dashboard gates anonymous visitors' "$dash → $c"
  elif [ "$c" = 200 ] && get_body "$base$dash" | grep -qiE 'log ?in'; then
    ok 'dashboard gates anonymous visitors' "$dash → 200 with a login surface"
  else
    bad 'dashboard gates anonymous visitors' "$dash → $c"
  fi
  local w1 w2
  w1=$(post_code "$base/api/billing/webhook" --data '{}')
  if is_4xx "$w1"; then ok 'billing webhook rejects unsigned payloads' "→ $w1"; else bad 'billing webhook rejects unsigned payloads' "→ $w1"; fi
  w2=$(post_code "$base/api/billing/webhook" -H 'stripe-signature: t=1,v1=deadbeef' --data '{"type":"customer.subscription.deleted"}')
  if is_4xx "$w2"; then ok 'billing webhook rejects forged signatures' "→ $w2"; else bad 'billing webhook rejects forged signatures' "→ $w2"; fi
  check_discovery "$base" yes
  check_linkcard "$base"
}

check_hub() {
  local base="$1"
  check_front "$base"; check_health_optional "$base"
  local c b
  c=$(get_code "$base/api/leads")
  [ "$c" = 401 ] && ok 'owner route refuses no-token reads' "api/leads → 401" || bad 'owner route refuses no-token reads' "api/leads → $c"
  c=$(get_code "$base/llms.txt"); b=$(get_body "$base/llms.txt")
  if [ "$c" = 200 ] && printf '%s' "$b" | grep -q 'nothing on this site is purchasable yet'; then
    ok 'llms.txt keeps the honesty line' 'purchasable-yet line present'
  else
    bad 'llms.txt keeps the honesty line' "llms.txt → $c"
  fi
  local r s
  r=$(get_code "$base/robots.txt"); s=$(get_code "$base/sitemap.xml")
  if [ "$r" = 200 ] && [ "$s" = 200 ]; then ok 'crawler files serve' "robots → $r, sitemap → $s"; else bad 'crawler files serve' "robots → $r, sitemap → $s"; fi
  b=$(get_body "$base/")
  if printf '%s' "$b" | grep -qi 'onrender\.com'; then
    bad 'no temporary Render domain in the UI' 'onrender.com found in the front page'
  else
    ok 'no temporary Render domain in the UI' 'suite links carry the canonical domain'
  fi
  check_linkcard "$base"
}

check_api() {
  local base="$1"
  check_front "$base"; check_health "$base"
  local c b
  c=$(get_code "$base/api/v1/openapi"); b=$(get_body "$base/api/v1/openapi")
  if [ "$c" = 200 ] && printf '%s' "$b" | grep -q '/api/v1/inbound/nucrm'; then
    ok 'OpenAPI contract published' 'incl. the NuCRM bridge path'
  else
    bad 'OpenAPI contract published' "api/v1/openapi → $c"
  fi
  c=$(get_code "$base/api/v1/whoami")
  case "$c" in 401|403) ok 'anonymous API calls refused' "whoami → $c" ;; *) bad 'anonymous API calls refused' "whoami → $c" ;; esac
  c=$(post_code "$base/api/v1/inbound/nucrm/acceptance-probe" --data '{}')
  if is_4xx "$c"; then ok 'NuCRM bridge refuses junk' "→ $c"; else bad 'NuCRM bridge refuses junk' "→ $c"; fi
  check_discovery "$base" yes
  check_linkcard "$base"
}

check_flow() {
  local base="$1"
  check_front "$base"; check_health "$base"
  local c; c=$(post_code "$base/api/webhooks/acceptance-probe" -H 'x-api-key: not-the-secret' --data '{}')
  if is_4xx "$c"; then ok 'workflow webhooks refuse a wrong secret' "→ $c"; else bad 'workflow webhooks refuse a wrong secret' "→ $c"; fi
  check_discovery "$base" yes
  check_linkcard "$base"
}

check_pdf() {
  local base="$1"
  check_front "$base"; check_health_optional "$base"
  check_discovery "$base" no
  check_linkcard "$base"
}

# The marketing site: front page now; the AI files (llms.txt, openapi.json,
# robots AI directives) ship with deploy/site-ai-pack. Not yet applied = an
# honest SKIP; served-but-wrong = FAIL.
check_site() {
  local base="$1" c b
  check_front "$base"
  c=$(get_code "$base/llms.txt"); b=$(get_body "$base/llms.txt")
  if [ "$c" = 200 ]; then
    if printf '%s' "$b" | grep -q '## Products'; then
      ok 'site llms.txt (AI index)' 'products section present'
    else
      bad 'site llms.txt (AI index)' 'served but missing the Products index'
    fi
  else
    skip 'site llms.txt (AI index)' "$c — apply deploy/site-ai-pack/ once the site repo is identified"
  fi
  c=$(get_code "$base/openapi.json"); b=$(get_body "$base/openapi.json")
  if [ "$c" = 200 ]; then
    if printf '%s' "$b" | grep -q '"openapi"'; then
      ok 'site openapi.json (contract)' 'OpenAPI document serves'
    else
      bad 'site openapi.json (contract)' 'served but not an OpenAPI document'
    fi
  else
    skip 'site openapi.json (contract)' "$c — ships with deploy/site-ai-pack/"
  fi
  c=$(get_code "$base/robots.txt"); b=$(get_body "$base/robots.txt")
  if [ "$c" != 200 ]; then
    bad 'site robots.txt serves' "robots.txt → $c"
  elif printf '%s' "$b" | grep -q 'GPTBot'; then
    ok 'site robots.txt AI directives' 'GPTBot block present'
  else
    skip 'site robots.txt AI directives' 'allow-list serves; the AI block ships with deploy/site-ai-pack/'
  fi
}

check_lite() {
  local base="$1"
  check_front "$base"
  local c; c=$(get_code "$base/api/health")
  [ "$c" = 200 ] && ok 'health answers' "api/health → 200" || skip 'health not exposed here' "api/health → $c"
}

default_targets=(
  "site        site  https://abetworks.in"
  "www         site  https://www.abetworks.in"
  "site-render site  https://abetworks-website.onrender.com"
  "tools       lite  https://tools.abetworks.in"
  "hub         hub   https://hub.abetworks.in"
  "analytics   paid  https://analytics.abetworks.in   /dashboard"
  "abetagent   paid  https://abetagent.abetworks.in   /dashboard"
  "leadgenius  paid  https://leadgenius.abetworks.in  /dashboard"
  "leadworks   paid  https://leadworks.abetworks.in   /dashboard"
  "connect     paid  https://connect.abetworks.in     /integrations"
  "api         api   https://api.abetworks.in"
  "flow        flow  https://flow.abetworks.in"
  "pdf         pdf   https://pdf.abetworks.in"
)

targets=("${default_targets[@]}")
if [ "${1:-}" != "" ] && [ -f "$1" ]; then
  mapfile -t targets < "$1"
fi

# Sourced (see deploy/acceptance/local/ or a scratch test)? Then only define
# functions and let the caller drive them.
if [ "${BASH_SOURCE[0]:-$0}" != "$0" ]; then
  return 0 2>/dev/null || exit 0
fi

for line in "${targets[@]}"; do
  [ -z "${line// }" ] && continue
  read -r name type base dash <<< "$line"
  [ -z "${dash:-}" ] && dash="/dashboard"
  echo
  echo "── $name  ·  $base  ·  [$type]"
  case "$type" in
    hub)  check_hub  "$base" ;;
    paid) check_paid "$base" "$dash" ;;
    api)  check_api  "$base" ;;
    flow) check_flow "$base" ;;
    pdf)  check_pdf  "$base" ;;
    site) check_site "$base" ;;
    lite) check_lite "$base" ;;
    *)    bad "unknown type '$type'" "$name" ;;
  esac
done

echo
echo "acceptance: ${PASS} passed · ${FAIL} failed · ${SKIP} skipped"
[ "$FAIL" -eq 0 ]
