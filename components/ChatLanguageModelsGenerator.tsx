'use client';

import { useMemo, useState } from 'react';
import catalog from '@/chatLanguageModels.json';

type Model = {
  id: string;
  name: string;
  [key: string]: unknown;
};

type Provider = {
  name: string;
  vendor: string;
  apiKey?: string;
  models: Model[];
  [key: string]: unknown;
};

const providers = catalog as Provider[];
const modelKey = (providerIndex: number, id: string) => `${providerIndex}:${id}`;

const allModelKeys = providers.flatMap((provider, providerIndex) =>
  provider.models.map((model) => modelKey(providerIndex, model.id)),
);

function selectedCatalog(selected: Set<string>) {
  return providers
    .map((provider, providerIndex) => ({
      ...provider,
      models: provider.models.filter((model) => selected.has(modelKey(providerIndex, model.id))),
    }))
    .filter((provider) => provider.models.length > 0);
}

export default function ChatLanguageModelsGenerator() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allModelKeys));
  const [filter, setFilter] = useState('');
  const [copied, setCopied] = useState(false);

  const visibleModels = useMemo(() => {
    const normalizedFilter = filter.trim().toLowerCase();
    return providers.flatMap((provider, providerIndex) =>
      provider.models
        .filter(
          (model) =>
            !normalizedFilter ||
            model.name.toLowerCase().includes(normalizedFilter) ||
            model.id.toLowerCase().includes(normalizedFilter),
        )
        .map((model) => ({ provider, providerIndex, model })),
    );
  }, [filter]);

  const config = useMemo(
    () => JSON.stringify(selectedCatalog(selected), null, 2),
    [selected],
  );

  const toggleModel = (providerIndex: number, id: string) => {
    const key = modelKey(providerIndex, id);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setCopied(false);
  };

  const selectAll = () => {
    setSelected(selected.size === allModelKeys.length ? new Set() : new Set(allModelKeys));
    setCopied(false);
  };

  const copyConfig = async () => {
    await navigator.clipboard.writeText(config);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <section className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Choose models</h2>
            <p className="mt-1 text-sm text-neutral-600">
              Select from the attached OmniRoute Azure catalog.
            </p>
          </div>
          <button
            type="button"
            onClick={selectAll}
            className="shrink-0 text-sm font-medium text-emerald-700 hover:text-emerald-800"
          >
            {selected.size === allModelKeys.length ? 'Clear all' : 'Select all'}
          </button>
        </div>

        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter models..."
          aria-label="Filter models"
          className="mt-6 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none ring-emerald-500 focus:ring-2"
        />

        <p className="mt-3 text-xs text-neutral-500">
          {selected.size.toLocaleString()} of {allModelKeys.length.toLocaleString()} selected
          {filter && ` · ${visibleModels.length.toLocaleString()} matches`}
        </p>

        <div className="mt-3 max-h-[36rem] divide-y divide-neutral-100 overflow-auto">
          {visibleModels.map(({ provider, providerIndex, model }) => {
            const key = modelKey(providerIndex, model.id);
            return (
              <label key={key} className="flex cursor-pointer items-start gap-3 py-3 first:pt-0">
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => toggleModel(providerIndex, model.id)}
                  className="mt-1 h-4 w-4 rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span className="min-w-0">
                  <span className="block break-all text-sm font-medium">{model.name}</span>
                  <span className="mt-1 block text-xs text-neutral-500">
                    {provider.name} · {model.id}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-950 shadow-sm">
        <div className="flex items-center justify-between border-b border-neutral-800 px-5 py-4">
          <div>
            <h2 className="font-medium text-white">chatLanguageModels.json</h2>
            <p className="mt-1 text-xs text-neutral-400">
              {selected.size.toLocaleString()} model{selected.size === 1 ? '' : 's'} selected
            </p>
          </div>
          <button
            type="button"
            onClick={copyConfig}
            disabled={selected.size === 0}
            className="rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? 'Copied!' : 'Copy JSON'}
          </button>
        </div>
        <pre className="max-h-[36rem] overflow-auto p-5 text-xs leading-5 text-emerald-100">
          <code>{config}</code>
        </pre>
      </section>
    </div>
  );
}
