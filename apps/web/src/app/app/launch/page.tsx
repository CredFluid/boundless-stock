import { launchPresets } from "@/lib/presets";
import { PageHeader } from "@/components/ui";
import { LaunchWizard } from "./wizard";

export const dynamic = "force-dynamic";
export const metadata = { title: "Launch an asset" };

export default function LaunchPage() {
  const presets = launchPresets();
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <PageHeader
        eyebrow="Issuer console"
        title="Launch an asset"
        description="Describe the asset and what backs it, choose the chains to distribute to and who may route orders. The result is a config that one command deploys."
      />
      <LaunchWizard presets={presets} />
    </div>
  );
}
