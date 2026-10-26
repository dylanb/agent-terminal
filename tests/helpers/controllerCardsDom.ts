/// <reference lib="dom" />

export function cardContractDom(): HTMLElement {
  const host = document.createElement('main');
  host.id = 'controller';
  host.innerHTML = `
    <header><h1>Controller</h1><span>2 terminals</span><button type="button">Dark theme</button></header>
    <article aria-labelledby="h-a">
      <button type="button" aria-expanded="false">Show full reason</button>
      <header><button type="button" id="h-a" aria-expanded="true"><span>project</span><span style="display: block">/w/a</span></button></header>
      <span data-testid="card-accent"></span>
      <p data-testid="card-status">Working</p>
      <p>Show full reason is a phrase inside a reason, not a control</p>
      <button type="button" aria-label="Bring forward /w/a"><svg aria-hidden="true"></svg></button>
    </article>
    <article aria-labelledby="h-ab">
      <header><button type="button" id="h-ab" aria-expanded="false"><span>project</span><span style="display: block"><span>/w/</span><span>ab</span></span></button></header>
      <span data-testid="card-accent"></span>
      <p data-testid="card-status">Disconnected</p>
      <button type="button" aria-label="Dismiss disconnected terminal /w/ab">Dismiss</button>
    </article>`;
  document.body.append(host);
  return host;
}
