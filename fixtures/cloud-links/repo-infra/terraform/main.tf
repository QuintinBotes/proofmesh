variable "returns_queue" {
  type    = string
  default = "orders.placed"
}

# Named after the orders service.
resource "azurerm_linux_web_app" "orders" {
  name                = "orders-api"
  resource_group_name = "apps"
  location            = "westeurope"
  service_plan_id     = "plan"

  site_config {}
}

# Its name names no repository; the image of its container names the storefront repository.
resource "azurerm_container_app" "shop" {
  name                         = "shop-web"
  container_app_environment_id = "env"
  resource_group_name          = "apps"
  revision_mode                = "Single"

  template {
    container {
      name   = "web"
      image  = "registry.example.test/storefront:1.4"
      cpu    = 0.5
      memory = "1Gi"
    }
  }
}

# Names nothing in the workspace.
resource "aws_lambda_function" "thumbnails" {
  function_name = "thumbnails"
  role          = "thumbnails"
  package_type  = "Image"
  image_uri     = "registry.example.test/thumbnails:2.0"
}

resource "azurerm_servicebus_topic" "placed" {
  name         = "orders.placed"
  namespace_id = "bus"
}

resource "aws_sns_topic" "shipped" {
  name = "Orders.Shipped"
}

# Its name is a variable, not a literal.
resource "azurerm_servicebus_queue" "returns" {
  name         = var.returns_queue
  namespace_id = "bus"
}
