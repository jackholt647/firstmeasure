# FirstMate Materials API Browser Client

`materials-api.js` exposes `window.MaterialsAPI` for the `/v1/materials` backend.

Primary groups:

- `MaterialsAPI.projects.list(orgId, projectId)`
- `MaterialsAPI.projects.create(orgId, projectId, payload)`
- `MaterialsAPI.lists.get/patch/archive/versions/createVersion/orders/createOrder/events`
- `MaterialsAPI.orders.get/patch/deliveries/recordDelivery`
- `MaterialsAPI.deliveries.patch`

The client mirrors the proposals API client: JSON requests, platform session cookies, and CSRF headers for mutating requests.
