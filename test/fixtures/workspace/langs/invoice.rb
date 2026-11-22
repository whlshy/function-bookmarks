module Billing
  class Invoice < ApplicationRecord
    # def commented_out
    def self.create_for(user)
      new(user: user)
    end

    def total
      items.sum do |i|
        if i.taxable?
          i.price * 1.05
        else
          i.price
        end
      end
    end

    def paid? = status == "paid"

    private

    def notes
      <<~TEXT
        def not_a_method
        end
      TEXT
    end
  end
end

def helper(x); x; end
