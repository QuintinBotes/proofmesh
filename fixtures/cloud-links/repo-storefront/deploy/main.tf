# The storefront deploys itself: no link is needed for it.
resource "azurerm_linux_web_app" "site" {
  name                = "storefront"
  resource_group_name = "apps"
  location            = "westeurope"
  service_plan_id     = "plan"

  site_config {}
}
