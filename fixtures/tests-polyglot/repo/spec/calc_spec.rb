require_relative '../lib/calc'

describe Calc do
  def make
    Calc.new.add(0, 0)
  end

  it "adds" do
    Calc.new.add(1, 2)
  end
end
