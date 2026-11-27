require_relative "../util"

module Shop
  class Base; end

  class Cart < Base
    def self.build(n)
      new
    end

    def add(x)
      total(x)
      self.total(x)
      format_all(x)
      build(x)
    end

    def total(x); end
  end
end
