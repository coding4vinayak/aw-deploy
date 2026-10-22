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
  check_llms_prices "$base"
}

# Every app's /llms.txt states its prices, and an AI assistant reads that file
# and quotes it. So a price in the llms.txt that the app's own pricing page
# does not carry is a price nobody sells — the worst kind of invented price,
# because it is the one an assistant repeats. This compares the two, live, on
# the host being deployed.
check_llms_prices() {
  local base="${1%/}" llms pricing
  llms=$(get_body "$base/llms.txt")
  pricing=$(get_body "$base/pricing")
  if [ -z "$pricing" ]; then
    skip 'llms.txt states the prices the pricing page states' "no pricing page to compare"
    return
  fi
  # The product's own price, from the llms.txt's Pricing block — the lines
  # from "Pricing" to the next blank one. A range (the suite's "$19-$99") is
  # a claim about the suite rather than about this product, so it is left to
  # the suite's own index and not compared here.
  local block stated missing=""
  block=$(printf '%s\n' "$llms" | awk '/^Pricing/ {printing=1} printing && /^$/ {printing=0} printing')
  stated=$(printf '%s' "$block" \
    | sed -E 's/\$[0-9][0-9,]*(\.[0-9]+)?[-–—]\$?[0-9][0-9,]*(\.[0-9]+)?/a range/g' \
    | grep -oE '\$[0-9][0-9,]*(\.[0-9]+)?' | sort -u)
  if [ -z "$stated" ]; then
    skip 'llms.txt states the prices the pricing page states' "the llms.txt names no price"
    return
  fi
  for amount in $stated; do
    # $19 in the llms.txt is $19 on the page; a comma is a thousands separator
    # the page may or may not print.
    if printf '%s' "$pricing" | grep -qF "$amount"; then continue; fi
    local bare="${amount//,/}"
    if printf '%s' "$pricing" | grep -qF "$bare"; then continue; fi
    missing="$missing $amount"
  done
  if [ -n "$missing" ]; then
    bad 'llms.txt states the prices the pricing page states' "not on the pricing page:$missing"
  else
    ok 'llms.txt states the prices the pricing page states' "$(printf '%s' "$stated" | tr '\n' ' ')"
  fi
}

# Every published app host must tell crawlers where its pages are. A sitemap
# that 404s or serves an empty urlset is the quiet half of the same failure as
# a dangling link card: nothing breaks in a browser, and search/AI discovery
# silently loses the pricing page.
check_sitemap() {
  local base="${1%/}" c b n off urls url dead total first
  c=$(get_code "$base/sitemap.xml"); b=$(get_body "$base/sitemap.xml")
  if [ "$c" != 200 ]; then
    bad 'sitemap.xml serves' "sitemap.xml → $c"
    return
  fi
  if ! printf '%s' "$b" | grep -q '<urlset'; then
    bad 'sitemap.xml is a urlset' 'served but no <urlset>'
    return
  fi
  urls=$(printf '%s' "$b" | tr -d '\n\r' | grep -oE '<loc>[^<]+</loc>' | sed -E 's#</?loc>##g')
  n=$(printf '%s' "$urls" | grep -c . || true)
  if [ "$n" -lt 1 ]; then
    bad 'sitemap.xml lists pages' 'served but no <loc>'
    return
  fi
  # A sitemap can have the right shape and advertise another app's host — the
  # copy-paste failure the per-app static files make easy. Every URL must
  # belong to the host being checked, or search engines are told to index
  # pages that live somewhere else.
  off=$(printf '%s' "$urls" | awk -v p="$base/" 'index($0,p)!=1' | grep -c . || true)
  if [ "$off" -gt 0 ]; then
    bad 'sitemap.xml lists this host' "$off of $n urls do not start with $base/"
    return
  fi
  ok 'sitemap.xml serves the page list' "sitemap → 200, $n urls, all on $base"
  # ... and every promised page must resolve. A sitemap full of 404s spends
  # crawl budget on dead ends and hides the page that should rank.
  dead=0; total=0; first=""
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    total=$((total + 1))
    c=$(get_code "$url")
    if ! is_ok_or_redirect "$c"; then
      dead=$((dead + 1))
      [ -z "$first" ] && first="$url → $c"
    fi
  done <<< "$urls"
  if [ "$dead" -gt 0 ]; then
    bad 'sitemap.xml pages resolve' "$dead of $total dead (first: $first)"
  else
    ok 'sitemap.xml pages resolve' "$total/$total → 2xx/3xx"
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

# The landing page promises a demo — "Open live demo — no card, ever" — and
# links straight at it. A demo workspace that was never seeded is an EMPTY
# dashboard behind that promise, and the first thing a prospect clicks is that
# link. So the sweep follows the page's own link and insists the demo is
# populated: the empty state is a failure, not a pass.
check_demo_workspace() {
  local base="$1" html link c body
  # The demo link is wherever the app puts it: the landing page for the four
  # apps that have one, the sign-in page for the app whose front door *is* the
  # app. Both are promises, so both are followed.
  html=$(get_body "$base/")
  link=$(printf '%s' "$html" | grep -oE 'href="[^"]*workspace=demo[^"]*"' | head -1 | sed 's/href="//; s/"$//')
  if [ -z "$link" ]; then
    html=$(get_body "$base/login")
    link=$(printf '%s' "$html" | grep -oE 'href="[^"]*workspace=demo[^"]*"' | head -1 | sed 's/href="//; s/"$//')
  fi
  if [ -z "$link" ]; then
    skip 'the demo workspace is populated' "the landing and sign-in pages link no demo workspace"
    return
  fi
  c=$(get_code "$base$link")
  if [ "$c" != 200 ]; then
    bad 'the demo workspace is populated' "$link → $c"
    return
  fi
  body=$(get_body "$base$link")
  if printf '%s' "$body" | grep -qiE 'no (metrics|leads|campaigns|agents|sequences|conversations) yet'; then
    bad 'the demo workspace is populated' "$link is an empty workspace — seed it"
  else
    ok 'the demo workspace is populated' "$link → 200, seeded"
  fi
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
  check_demo_workspace "$base"
  check_suite_prices "$base"
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
  local r
  r=$(get_code "$base/robots.txt")
  [ "$r" = 200 ] && ok 'robots.txt serves' "robots → 200" || bad 'robots.txt serves' "robots → $r"
  check_sitemap "$base"
  b=$(get_body "$base/")
  if printf '%s' "$b" | grep -qi 'onrender\.com'; then
    bad 'no temporary Render domain in the UI' 'onrender.com found in the front page'
  else
    ok 'no temporary Render domain in the UI' 'suite links carry the canonical domain'
  fi
  check_linkcard "$base"
}

# Crawlers and API tooling probe /openapi.json first. It must be the same
# document — a second copy would be a contract that can drift.
check_openapi_alias() {
  local base="${1%/}" c b b2
  c=$(get_code "$base/openapi.json"); b2=$(get_body "$base/openapi.json")
  b=$(get_body "$base/api/v1/openapi")
  if [ "$c" = 200 ] && [ "$b2" = "$b" ]; then
    ok 'openapi.json serves the same contract' 'conventional alias → 200, byte-identical'
  else
    bad 'openapi.json serves the same contract' "openapi.json → $c (or differs from /api/v1/openapi)"
  fi
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
  check_openapi_alias "$base"
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
  check_demo_workspace "$base"
  check_suite_prices "$base"
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

# The suite on a pricing page: every companion's price must be the price that
# product actually charges.
#
# Each product's pricing page names the products teams pair it with, and says
# what each of them costs. A price there that the other product no longer
# charges is a price a buyer would be quoted for a plan that does not exist —
# and the other product's own page is right there to be compared with. So the
# check fetches the companion's own pricing page and compares.
check_suite_prices() {
  local base="${1%/}" page section entry name href price other other_body
  page=$(get_body "$base/pricing")
  if [ -z "$page" ]; then
    skip 'the suite section quotes real prices' "no pricing page to read"
    return
  fi
  # The section: the lines after its heading, up to the next heading. (The
  # heading itself contains an <h2>, so a range that ends at the next <h2
  # would end on the heading and read nothing at all.)
  section=$(printf '%s' "$page" | sed -n '/Also in the Abetworks suite/,$p' | sed '1d' | sed '/<h2/,$d')
  if [ -z "$section" ]; then
    skip 'the suite section quotes real prices' "the page has no suite section"
    return
  fi
  local problems="" compared=0
  # Each companion is an anchor with the product's own host in it and the price
  # in its text.
  while IFS= read -r entry; do
    href=$(printf '%s' "$entry" | grep -oE 'href="https?://[a-z.]+abetworks\.in[^"]*"' | head -1 | sed 's/href="//; s/"$//')
    name=$(printf '%s' "$entry" | grep -oE '>[A-Z][A-Za-z]+</span>' | head -1 | sed 's/>//; s#</span>##')
    price=$(printf '%s' "$entry" | grep -oE '\$[0-9][0-9,]*(\.[0-9]+)?' | head -1)
    [ -z "$href" ] || [ -z "$price" ] && continue
    compared=$((compared + 1))
    # A rehearsal can point the companions at a local stand-in; in production
    # the link in the section is the address to fetch.
    local companion_base="${AW_SUITE_COMPANION_BASE:-${href%/}}"
    other_body=$(get_body "$companion_base/pricing")
    if [ -z "$other_body" ]; then
      problems="$problems $name (its own page did not answer)"
      continue
    fi
    if ! printf '%s' "$other_body" | grep -qF "$price"; then
      problems="$problems $name quotes $price, which its own page does not"
    fi
  done <<< "$(printf '%s' "$section" | tr '\n' ' ' | grep -oE '<a href="https?://[a-z.]+abetworks\.in[^"]*"[^>]*>.*?</a>')"
  if [ "$compared" -eq 0 ]; then
    # Nothing to compare — the section's companions are reached by mail rather
    # than by a link, so there is no page to check them against. Said out loud
    # rather than passed in silence.
    skip 'the suite section quotes real prices' "no companion links to a page to compare"
  elif [ -n "$problems" ]; then
    bad 'the suite section quotes real prices' "$problems"
  else
    ok 'the suite section quotes real prices' "$compared companion(s), each quoting its own page's price"
  fi
}

check_site() {
  local base="$1" c b
  check_front "$base"
  c=$(get_code "$base/llms.txt"); b=$(get_body "$base/llms.txt")
  if [ "$c" = 200 ]; then
    # Shape first, then truth. The index must have a title and sections, and
    # every path it names must exist on this deployment — the check that
    # catches an index pointing at pages the site does not have. (The paths are
    # probed against the host being checked, because the absolute origin in
    # the file is the canonical domain, which is a separate concern: the
    # front-page probe above already reports on it.)
    if ! printf '%s' "$b" | head -1 | grep -q '^# '; then
      bad 'site llms.txt (AI index)' 'served but no title line'
    elif ! printf '%s' "$b" | grep -q '^## '; then
      bad 'site llms.txt (AI index)' 'served but no sections'
    else
      ok 'site llms.txt (AI index)' "$(printf '%s' "$b" | grep -c '^## ') sections"
      check_index_paths "$base" "$b"
    fi
  else
    skip 'site llms.txt (AI index)' "$c — apply deploy/site-ai-pack/ (the site repo is now identified)"
  fi
  c=$(get_code "$base/openapi.json"); b=$(get_body "$base/openapi.json")
  if [ "$c" = 200 ]; then
    if printf '%s' "$b" | grep -q '"openapi"'; then
      ok 'site openapi.json (contract)' 'OpenAPI document serves'
    else
      bad 'site openapi.json (contract)' 'served but not an OpenAPI document'
    fi
    # The contract the site advertises must be the contract the gateway
    # serves: the same paths, so an integrator who reads the site's copy finds
    # the endpoint they need. The pack ships a copy and prefers the live one,
    # and this is what says whether the copy that landed is the right one —
    # the copy that was in the pack was two versions behind and missing the
    # NuCRM inbound bridge.
    local gateway_spec gateway_paths site_paths missing
    gateway_spec="${AW_GATEWAY_SPEC_URL:-https://api.abetworks.in/api/v1/openapi}"
    gateway_paths=$(curl -fsS --max-time 15 "$gateway_spec" 2>/dev/null | grep -oE '"/[^"]+":' | tr -d '":' | sort -u)
    if [ -z "$gateway_paths" ]; then
      skip 'site openapi.json is the gateway contract' "the gateway contract was not reachable"
    else
      site_paths=$(printf '%s' "$b" | grep -oE '"/[^"]+":' | tr -d '":' | sort -u)
      missing=$(comm -23 <(printf '%s\n' "$gateway_paths") <(printf '%s\n' "$site_paths"))
      if [ -n "$missing" ]; then
        bad 'site openapi.json is the gateway contract' "the site contract is missing:$(printf '%s' "$missing" | tr '\n' ' ')"
      else
        ok 'site openapi.json is the gateway contract' "$(printf '%s\n' "$site_paths" | wc -l | tr -d ' ') paths, the same set"
      fi
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
  check_site_sitemap "$base"
}

# Every path an index names must exist on the site that published it. An
# index that links pages which 404 tells an AI assistant the site is bigger
# than it is — and the site this pack was first written for had exactly that
# problem: a sitemap advertising 32 dead URLs.
check_index_paths() {
  local base="${1%/}" body="$2" paths path dead=0 total=0 first=""
  paths=$(printf '%s' "$body" \
    | grep -oE '\]\(https?://[^)]+\)|^- +https?://[^ ]+' \
    | sed -E 's/^\]\(//; s/\)$//; s/^- +//' \
    | sed -E 's#^[a-z]+://[^/]+##' \
    | sed -E 's/[?#].*$//' \
    | sed -E 's#^$#/#' | sort -u)
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    case "$path" in /sitemap.xml|/llms.txt) continue ;; esac
    total=$((total + 1))
    local code
    code=$(get_code "$base$path")
    if ! is_ok_or_redirect "$code"; then
      dead=$((dead + 1))
      [ -z "$first" ] && first="$path → $code"
    fi
  done <<< "$paths"
  if [ "$total" -eq 0 ]; then
    bad 'site llms.txt links real pages' 'the index names no pages at all'
  elif [ "$dead" -gt 0 ]; then
    bad 'site llms.txt links real pages' "$dead of $total do not resolve (first: $first)"
  else
    ok 'site llms.txt links real pages' "$total paths resolve"
  fi
}

# The site's sitemap may point at other hosts on purpose — it links the
# Abetworks product suite — so the "must be this host" rule the app hosts use
# does not apply. The rule that does apply is the same everywhere: every URL
# it lists must resolve.
check_site_sitemap() {
  local base="${1%/}" c b urls n dead=0 total=0 first="" host
  c=$(get_code "$base/sitemap.xml"); b=$(get_body "$base/sitemap.xml")
  if [ "$c" != 200 ]; then
    bad 'site sitemap.xml serves' "sitemap.xml → $c"
    return
  fi
  if ! printf '%s' "$b" | grep -q '<urlset'; then
    bad 'site sitemap.xml is a urlset' 'served but no <urlset>'
    return
  fi
  urls=$(printf '%s' "$b" | tr -d '\n\r' | grep -oE '<loc>[^<]+</loc>' | sed -E 's#</?loc>##g' | sed 's/&amp;/\&/g')
  n=$(printf '%s' "$urls" | grep -c . || true)
  if [ "$n" -lt 1 ]; then
    bad 'site sitemap.xml lists pages' 'served but no <loc>'
    return
  fi
  # Only this domain and its own subdomains: a sitemap that advertises
  # somebody else's host is a copy-paste accident.
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    host=$(printf '%s' "$url" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##')
    case "$host" in
      abetworks.in|*.abetworks.in) ;;
      *) bad 'site sitemap.xml lists this domain' "$url is not on abetworks.in"; return ;;
    esac
  done <<< "$urls"
  ok 'site sitemap.xml serves the page list' "sitemap → 200, $n urls"
  # A URL on the canonical domain is checked by its PATH on the deployment
  # being swept: the domain is a separate concern (the front-page probe above
  # reports on it), and what matters here is that the page exists. A URL on
  # another host is a different deployment and is checked as it is.
  while IFS= read -r url; do
    [ -z "$url" ] && continue
    total=$((total + 1))
    local path target host
    path=$(printf '%s' "$url" | sed -E 's#^[a-z]+://[^/]+##; s/[?#].*$//')
    [ -z "$path" ] && path="/"
    host=$(printf '%s' "$url" | sed -E 's#^[a-z]+://##; s#/.*$##; s#:[0-9]+$##')
    case "$host" in
      abetworks.in|www.abetworks.in) target="$base$path" ;;
      *) target="$url" ;;
    esac
    c=$(get_code "$target")
    if ! is_ok_or_redirect "$c"; then
      dead=$((dead + 1))
      [ -z "$first" ] && first="$url → $c"
    fi
  done <<< "$urls"
  if [ "$dead" -gt 0 ]; then
    bad 'site sitemap.xml pages resolve' "$dead of $total dead (first: $first)"
  else
    ok 'site sitemap.xml pages resolve' "$total urls resolve"
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
