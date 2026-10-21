import { HydrationScript, type JSX } from '@solidjs/web';
import './app.css';

export default function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>ldn.house</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta name="theme-color" content="#101218" />
        <link rel="canonical" href="https://ldn.house/" />
        <meta
          name="description"
          content="Energy and climate data for one house in London."
        />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="ldn.house" />
        <meta property="og:locale" content="en_GB" />
        <meta property="og:title" content="ldn.house" />
        <meta
          property="og:description"
          content="Energy and climate data for one house in London."
        />
        <meta property="og:url" content="https://ldn.house/" />
        <meta property="og:image" content="https://ldn.house/share.png" />
        <meta property="og:image:type" content="image/png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta
          property="og:image:alt"
          content="ldn.house — energy and climate data for one house in London. An amber house on a dark background."
        />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="ldn.house" />
        <meta
          name="twitter:description"
          content="Energy and climate data for one house in London."
        />
        <meta name="twitter:image" content="https://ldn.house/share.png" />
        <meta
          name="twitter:image:alt"
          content="ldn.house — energy and climate data for one house in London. An amber house on a dark background."
        />
        <HydrationScript />
      </head>
      <body class="bg-surface text-neutral-100 antialiased">{props.children}</body>
    </html>
  );
}
