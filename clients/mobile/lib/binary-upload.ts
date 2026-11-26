// Expo fetch accepts the Blob interface when React Native's global Blob rejects binary input.
export class BinaryUpload implements Blob {
  constructor(private readonly data: Uint8Array<ArrayBuffer>, readonly type: string) {}

  get size() { return this.data.length; }

  slice(start?: number, end?: number, type = '') { return new BinaryUpload(this.data.slice(start, end), type); }

  async bytes() { return this.data.slice(); }

  async arrayBuffer() { return (await this.bytes()).buffer; }

  stream() {
    return new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (controller) => {
      controller.enqueue(this.data.slice());
      controller.close();
    } });
  }

  async text() { return new TextDecoder().decode(this.data); }
}
