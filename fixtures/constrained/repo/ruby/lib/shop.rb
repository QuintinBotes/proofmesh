require_relative "shop/cart"
require "shop/version"
require "json"

module Shop
  def self.start
    Cart.new
    Shop::Cart.build(1)
    Cart.build(2)
    helper(3)
    format_all(4)
    Cart.new.add(5)
    Missing.go(6)
  end

  def self.helper(x); end
end
