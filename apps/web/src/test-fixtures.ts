// Isolated component/parser tests only. Production never imports this module.
export const rowJSON = '{"variant_id":1,"catalog_entry_id":1,"brand":"TOYO","model":"A_%\\\\","capacity_ah":6.5,"polarity":"L","existing":9007199254740993,"reserved":1,"available":9007199254740992}';
export const pageJSON = (items = rowJSON, page = 1, total = 190) => `{"location":{"id":1,"name":"Almacén"},"items":[${items}],"page":${page},"page_size":10,"total_variants":${total}}`;
