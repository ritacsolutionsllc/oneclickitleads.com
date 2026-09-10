import Link from 'next/link';
import ChatLanguageModelsGenerator from '@/components/ChatLanguageModelsGenerator';

export const metadata = {
  title: 'Azure Chat Models Generator — OneClickitLeads',
  description: 'Generate a chatLanguageModels.json block for VS Code GitHub Copilot.',
};

export default function ChatModelsPage() {
  return (
    <main className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            <span className="text-emerald-600">OneClick</span>itLeads
          </Link>
          <Link href="/" className="text-sm text-neutral-600 hover:text-neutral-900">
            Back to home
          </Link>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="mb-10 max-w-2xl">
          <p className="mb-3 text-sm uppercase tracking-widest text-emerald-700">Developer utility</p>
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
            Configure Azure models for VS Code.
          </h1>
          <p className="mt-5 text-lg text-neutral-600">
            Select the models you want GitHub Copilot to expose, then copy the generated
            <code className="mx-1 rounded bg-neutral-200 px-1.5 py-0.5 text-base text-neutral-800">chatLanguageModels.json</code>
            block into your configuration.
          </p>
        </div>

        <ChatLanguageModelsGenerator />

        <p className="mt-6 text-sm text-neutral-500">
          Model availability and limits depend on your Azure region and deployment. Match each
          <code className="mx-1 rounded bg-neutral-200 px-1 text-neutral-700">id</code>
          to your Azure deployment name when needed.
        </p>
      </div>
    </main>
  );
}
