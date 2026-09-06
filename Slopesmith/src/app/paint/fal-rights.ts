import {
  FAL_OUTPUT_NOTICE, FAL_PROVIDER_TERMS, falEndpoint,
} from '../../core/paint/fal-models';

const link = (label: string, href: string): HTMLAnchorElement => {
  const a = document.createElement('a');
  a.textContent = label;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
};

/** Compact model-specific legal disclosure shared by all three fal generation dialogs. The caller updates
 * it whenever a model or optional second pass changes, so the permission visible when Generate is pressed
 * is for the endpoints that will actually be billed. */
export function createFalRightsDisclosure(): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'hint fal-rights';
  return el;
}

export function renderFalRightsDisclosure(el: HTMLElement, modelIds: readonly string[]): void {
  el.replaceChildren();
  const endpoints = [...new Set(modelIds)].map(falEndpoint);
  if (!endpoints.length || endpoints.some(endpoint => !endpoint)) {
    const warning = document.createElement('span');
    warning.className = 'warn';
    warning.textContent = 'This model has no reviewed licence/status and generation is disabled.';
    el.appendChild(warning);
    return;
  }

  endpoints.forEach((endpoint, index) => {
    if (index) el.appendChild(document.createElement('br'));
    el.append(document.createTextNode(`${endpoint!.label}: ${endpoint!.terms.statusLabel} · `),
      link('model licence/status', endpoint!.terms.licenseUrl),
      document.createTextNode(` · reviewed ${endpoint!.terms.reviewedAt}`));
  });
  el.append(document.createElement('br'),
    link('fal Terms', FAL_PROVIDER_TERMS.termsOfService), document.createTextNode(' · '),
    link('API Terms', FAL_PROVIDER_TERMS.apiServicesTerms), document.createTextNode(' · '),
    link('AUP', FAL_PROVIDER_TERMS.acceptableUsePolicy), document.createTextNode(' · '),
    link('model licensing FAQ', FAL_PROVIDER_TERMS.modelLicensingFaq),
    document.createElement('br'));
  const warning = document.createElement('span');
  warning.className = 'warn';
  warning.textContent = FAL_OUTPUT_NOTICE;
  el.appendChild(warning);
}
