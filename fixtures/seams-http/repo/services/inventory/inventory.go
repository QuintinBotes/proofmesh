package inventory

import "net/http"

// ListInventory serves GET /api/inventory, as services/inventory/swagger.json declares.
func ListInventory(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
}
