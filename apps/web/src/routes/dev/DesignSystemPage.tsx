import { useState } from "react";
import { Button, ButtonLink } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Inline, Stack } from "../../components/ui/Stack";
import { Eyebrow, Heading, Text } from "../../components/ui/Typography";
import { Toggle } from "../../components/ui/Toggle";
import styles from "./DesignSystemPage.module.css";

export function DesignSystemPage() {
  const [enabled, setEnabled] = useState(true);

  return (
    <main className={styles.shell}>
      <Stack gap="xl">
        <Stack gap="sm">
          <Eyebrow>Design system</Eyebrow>
          <Heading as="h1" size="xl">
            Popcorn Ready UI primitives
          </Heading>
          <Text tone="muted" size="lg">
            Shared components for buttons, toggles, spacing, and typography. New UI should use these primitives before adding route-specific CSS.
          </Text>
        </Stack>

        <Card elevated padding="lg">
          <Stack gap="lg">
            <Stack gap="sm">
              <Heading as="h2" size="md">Buttons</Heading>
              <Text tone="muted">Use one CTA per screen. Primary is the standard accent action; secondary and ghost are supporting actions.</Text>
            </Stack>
            <Inline gap="sm">
              <Button variant="cta">Create video</Button>
              <Button variant="primary">Save changes</Button>
              <Button variant="secondary">Preview</Button>
              <Button variant="ghost">Cancel</Button>
              <Button variant="secondary" isLoading>Rendering</Button>
              <ButtonLink variant="secondary" to="/studio">Open studio</ButtonLink>
            </Inline>
          </Stack>
        </Card>

        <Card padding="lg">
          <Stack gap="lg">
            <Stack gap="sm">
              <Heading as="h2" size="md">Toggles</Heading>
              <Text tone="muted">Use toggles for binary settings where the current state should stay visible.</Text>
            </Stack>
            <Toggle
              checked={enabled}
              onChange={(event) => setEnabled(event.currentTarget.checked)}
              label="Require review before export"
              description="Pause the run until a user approves the generated cut."
            />
            <Toggle
              disabled
              label="Auto-publish output"
              description="Disabled controls keep the same layout and state semantics."
            />
          </Stack>
        </Card>

        <Card padding="lg">
          <Stack gap="lg">
            <Stack gap="sm">
              <Heading as="h2" size="md">Spacing</Heading>
              <Text tone="muted">Stack and Inline map component spacing to the app's token rhythm.</Text>
            </Stack>
            <Stack gap="sm">
              <div className={styles.swatch}>gap sm</div>
              <div className={styles.swatch}>gap sm</div>
            </Stack>
            <Inline gap="md">
              <div className={styles.swatch}>inline</div>
              <div className={styles.swatch}>gap md</div>
              <div className={styles.swatch}>wraps</div>
            </Inline>
          </Stack>
        </Card>

        <Card padding="lg">
          <Stack gap="lg">
            <Stack gap="sm">
              <Heading as="h2" size="md">Typography</Heading>
              <Text tone="muted">Heading, Text, and Eyebrow keep scale, tone, and line-height consistent.</Text>
            </Stack>
            <Stack gap="sm">
              <Eyebrow>Eyebrow</Eyebrow>
              <Heading size="lg">Heading large</Heading>
              <Heading size="md">Heading medium</Heading>
              <Text size="lg">Large body text for short supporting copy.</Text>
              <Text>Default body text for dense application surfaces.</Text>
              <Text size="sm" tone="muted">Small muted text for captions and metadata.</Text>
              <Text tone="danger">Danger text for validation and destructive warnings.</Text>
            </Stack>
          </Stack>
        </Card>
      </Stack>
    </main>
  );
}
