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
        description="Describe the asset, choose its home chain and the chains it should reach. The result is a deployment config the pipeline runs as-is."
      />
      <LaunchWizard presets={presets} />
    </div>
  );
}
