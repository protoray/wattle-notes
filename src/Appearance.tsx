import { themes, type ThemeId } from './themes';

export default function Appearance({
  theme,
  onChange,
  onClose,
}: {
  theme: ThemeId;
  onChange: (theme: ThemeId) => void;
  onClose: () => void;
}) {
  return (
    <div className="appearance-content">
      <p className="muted">
        Choose a look that feels comfortable. Changes apply immediately and are saved on this
        device.
      </p>
      <fieldset className="theme-options">
        <legend>Notebook theme</legend>
        {themes.map((option) => (
          <label className="theme-choice" key={option.id}>
            <input
              type="radio"
              name="notebook-theme"
              value={option.id}
              checked={theme === option.id}
              onChange={() => onChange(option.id)}
            />
            <span className="theme-card">
              <span className="theme-preview" data-theme={option.id} aria-hidden="true">
                <span className="theme-preview-sidebar">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-preview-page">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </span>
              <span className="theme-name">
                {option.name}
                <span className="theme-selected" aria-hidden="true">
                  {theme === option.id ? '✓' : ''}
                </span>
              </span>
              <span className="theme-description">{option.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className="small muted">
        The Dark mode switch remembers your last light and dark choices.
      </p>
      <div className="button-row">
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
