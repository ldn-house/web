import { HydrationScript, type JSX } from '@solidjs/web';
import './app.css';

export default function Document(props: { children: JSX.Element }) {
  return (
    <html lang="en-GB">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>ldn.house</title>
        <meta
          name="description"
          content="Energy and climate data for one house in London."
        />
        <HydrationScript />
      </head>
      <body class="bg-surface text-neutral-100 antialiased">{props.children}</body>
    </html>
  );
}
