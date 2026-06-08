import { NavLink } from "react-router-dom";
import { LogoMark } from "./LogoMark";

const SIDEBAR_ITEMS = [
  { to: "/studio", label: "Studio", icon: "studio" },
  { to: "/projects", label: "Projects", icon: "projects" },
  { to: "/uploads", label: "Uploads", icon: "uploads" },
  { to: "/templates", label: "Templates", icon: "templates" },
  { to: "/brand", label: "Brand Kit", icon: "brand" },
  { to: "/settings", label: "Settings", icon: "settings" },
];

export function StudioSidebar() {
  return (
    <aside className="studio-sidebar" aria-label="Workspace navigation">
      <NavLink className="studio-sidebar-brand" to="/studio" aria-label="Popcorn Ready Studio">
        <LogoMark className="studio-sidebar-logo" />
        <span>Popcorn Ready</span>
      </NavLink>

      <nav className="studio-sidebar-nav">
        {SIDEBAR_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive ? "studio-sidebar-link active" : "studio-sidebar-link"
            }
          >
            <span
              className={`studio-sidebar-icon studio-sidebar-icon-${item.icon}`}
              aria-hidden="true"
            />
            <span className="studio-sidebar-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
