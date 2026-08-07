/** API 响应包装 */
export interface ApiResponse<T> {
  data: T
  /** 可选元信息（如多实例语义说明），非所有接口返回 */
  meta?: Record<string, unknown>
}

/** API 错误响应 */
export interface ApiError {
  error: string | Record<string, unknown>
}

/** 分页参数 */
export interface PaginationParams {
  page?: number
  pageSize?: number
}

/** 分页元数据 */
export interface PaginationMeta {
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/** 分页结果 */
export interface PaginatedResponse<T> {
  data: T[]
  pagination: PaginationMeta
}
