import {
  BarChartOutlined,
  BoltOutlined,
  BookOutlined,
  CampaignOutlined,
  GroupsOutlined,
  InboxOutlined,
  LanOutlined,
  ManageAccountsOutlined,
  PeopleOutlined,
  PersonOutlined,
  SettingsOutlined,
} from "@mui/icons-material";

import { MenuItemGroup } from "./types";

// ==============================|| MENU ITEMS ||============================== //

const menuItems: { items: MenuItemGroup[] } = {
  items: [
    {
      id: "engage",
      title: "Engage",
      type: "group",
      children: [
        {
          id: "broadcasts",
          title: "Campaigns",
          type: "item",
          url: "/broadcasts",
          icon: CampaignOutlined,
          description:
            "Create and monitor one-time Push and WhatsApp campaigns.",
        },
        {
          id: "journeys",
          title: "Journeys",
          type: "item",
          url: "/journeys",
          icon: LanOutlined,
          description: "Build automated, event-triggered customer journeys.",
        },
        {
          id: "messages",
          title: "Templates",
          type: "item",
          url: "/templates",
          icon: BookOutlined,
          description: "Manage reusable Push and WhatsApp content.",
        },
      ],
    },
    {
      id: "audience",
      title: "Audience",
      type: "group",
      children: [
        {
          id: "people",
          title: "Find People",
          type: "item",
          url: "/users",
          icon: PersonOutlined,
          description:
            "Find users and inspect their event and message history.",
        },
        {
          id: "segments",
          title: "Segments",
          type: "item",
          url: "/segments",
          icon: GroupsOutlined,
          description: "View, create, and edit segments.",
        },
        {
          id: "events",
          title: "Events",
          type: "item",
          url: "/events",
          icon: BoltOutlined,
          description: "Explore events and properties available for targeting.",
        },
        {
          id: "user-properties",
          title: "User Properties",
          type: "item",
          url: "/user-properties",
          icon: ManageAccountsOutlined,
          description: "Manage recorded and computed user properties.",
        },
        {
          id: "subscription-groups",
          title: "Channel Preferences",
          type: "item",
          url: "/subscription-groups",
          icon: PeopleOutlined,
          description: "Manage channel subscriptions and consent.",
        },
      ],
    },
    {
      id: "reporting",
      title: "Reporting",
      type: "group",
      children: [
        {
          id: "analysis",
          title: "Overview",
          type: "item",
          url: "/analysis/overview",
          icon: BarChartOutlined,
          description: "Analyze messaging performance across the workspace.",
        },
        {
          id: "deliveries",
          title: "Delivery Reports",
          type: "item",
          url: "/deliveries",
          icon: InboxOutlined,
          description:
            "Inspect sent, delivered, clicked, read and failed messages.",
        },
      ],
    },
    {
      id: "workspace",
      title: "Workspace",
      type: "group",
      children: [
        {
          id: "settings",
          title: "Settings",
          type: "item",
          url: "/settings",
          icon: SettingsOutlined,
          description:
            "Configure providers, credentials and workspace settings.",
        },
      ],
    },
  ],
};

export default menuItems;
