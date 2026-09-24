import { createElement as h } from 'react';
import { render, Box, Text } from 'ink';

function App() {
  return h(Box, { borderStyle: 'round', paddingX: 1 },
    h(Text, null, 'vin — press Ctrl+C to quit'));
}

export async function start(vin) {
  const { waitUntilExit } = render(h(App, { vin }));
  await waitUntilExit();
}
