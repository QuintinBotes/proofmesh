// Shaped like TypeORM's own DataSource, so Observatory's keyboard test has DataSource.initialize to open (#43). Maps no table.
export class DataSource {
  isInitialized = false

  async initialize(): Promise<this> {
    await this.buildMetadatas()
    this.isInitialized = true
    return this
  }

  async destroy(): Promise<void> {
    this.isInitialized = false
  }

  protected async buildMetadatas(): Promise<void> {}
}
