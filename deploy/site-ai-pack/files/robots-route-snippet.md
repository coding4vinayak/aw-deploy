# robots as a Next.js route — merge snippet

The live site serves `/robots.txt` in exactly the shape a Next.js
`app/robots.ts` produces (the same shape abetpdf serves), so the site most
likely has a robots route. **If it does, do not add `files/robots.txt`** —
Next gives the route precedence and a `public/robots.txt` would be dead
file. Merge the two AI blocks into the existing route instead:

```ts
import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // keep whatever the route already had here, e.g.:
      { userAgent: '*', allow: '/' },
      { userAgent: ['Googlebot', 'Bingbot', 'DuckDuckBot', 'Applebot'], allow: '/' },
      // new — AI assistants and crawlers read the llms.txt index:
      { userAgent: ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'], allow: '/' },
    ],
    host: 'https://abetworks.in',
    sitemap: 'https://abetworks.in/sitemap.xml',
  };
}
```

Then verify after deploy:

```sh
curl -s https://abetworks.in/robots.txt | grep -E 'GPTBot|llms.txt'
```

(The comment lines from `files/robots.txt` can't carry into a route;
that's fine — the directives are what crawlers read.)
