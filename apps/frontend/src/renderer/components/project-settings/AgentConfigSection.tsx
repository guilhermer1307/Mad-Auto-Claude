import { Label } from '../ui/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '../ui/select';
import { getModelsGroupedByProvider } from '../../../shared/constants';
import type { ProjectSettings } from '../../../shared/types';

interface AgentConfigSectionProps {
  settings: ProjectSettings;
  onUpdateSettings: (updates: Partial<ProjectSettings>) => void;
}

export function AgentConfigSection({ settings, onUpdateSettings }: AgentConfigSectionProps) {
  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">Agent Configuration</h3>
      <div className="space-y-2">
        <Label htmlFor="model" className="text-sm font-medium text-foreground">Model</Label>
        <Select
          value={settings.model}
          onValueChange={(value) => onUpdateSettings({ model: value })}
        >
          <SelectTrigger id="model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {getModelsGroupedByProvider().map((group) => (
              <SelectGroup key={group.provider}>
                <SelectLabel className="text-xs font-semibold text-muted-foreground">{group.label}</SelectLabel>
                {group.models.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
