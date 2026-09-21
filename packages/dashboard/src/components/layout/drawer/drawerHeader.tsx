import { CampaignOutlined } from "@mui/icons-material";
import { Box, Stack, Typography } from "@mui/material";

// project import
import DrawerHeaderStyled from "./drawerHeader/drawerHeaderStyled";

// ==============================|| DRAWER HEADER ||============================== //

function DrawerHeader({ open }: { open: boolean }) {
  return (
    <DrawerHeaderStyled open={open}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box
          sx={{
            width: 34,
            height: 34,
            display: "grid",
            placeItems: "center",
            borderRadius: 1.5,
            bgcolor: "primary.main",
            color: "primary.contrastText",
            flexShrink: 0,
          }}
        >
          <CampaignOutlined fontSize="small" />
        </Box>
        {open ? (
          <Stack spacing={0}>
            <Typography variant="subtitle1" fontWeight={800} lineHeight={1.1}>
              STAGE ENGAGE
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Campaign workspace
            </Typography>
          </Stack>
        ) : null}
      </Stack>
    </DrawerHeaderStyled>
  );
}

export default DrawerHeader;
